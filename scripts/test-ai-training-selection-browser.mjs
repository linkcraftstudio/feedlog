import { chromium } from 'playwright-core';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
// Requires a local admin test account. Product reads are intercepted; no content is changed.
const phase = 'optimized';
const origin = process.env.AI_TRAINING_UI_ORIGIN || 'http://localhost:3002';
const email = process.env.AI_TRAINING_TEST_EMAIL, password = process.env.AI_TRAINING_TEST_PASSWORD;
if (!email || !password)
    throw new Error('Set AI_TRAINING_TEST_EMAIL and AI_TRAINING_TEST_PASSWORD for a local admin test account.');
const result = { phase, checks: [], pageErrors: [], requests: [], timings: [] };
const browser = await chromium.launch({ headless: true, executablePath: process.env.AI_TRAINING_UI_BROWSER, args: ['--no-sandbox'] });
try {
    const context = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    assert.equal((await context.request.post('/api/auth/sign-in/email', { headers: { Origin: process.env.AI_TRAINING_AUTH_ORIGIN || origin }, data: { email, password } })).status(), 200);
    const id = '40000000-0000-4000-8000-000000000001', now = new Date().toISOString();
    let listDelay = 20, helpRequests = 0;
    let retryRelease, retryStarted, rejectRetry = false, retryRequests = 0;
    const retryStates = new Map();
    let count = 79, failSecond = false, hold = false, showErrors = false, syncing = false, failureCount = 0, fetchFailureCount = 0, singleRun = false, release, heldResolve;
    let held = new Promise(r => heldResolve = r);
    const item = (i) => { const syncStatus = retryStates.get(i) || (showErrors && i < 5 ? 'failed' : 'ready'); return ({ id: `40000000-0000-4000-8001-${String(i).padStart(12, '0')}`, websiteId: id, title: 'Selection page ' + i, url: 'https://example.com/' + i, status: syncStatus === 'failed' ? 'failed' : ['pending', 'processing'].includes(syncStatus) ? 'indexing' : 'ready', syncStatus, errorStage: syncStatus === 'failed' ? i === 2 ? 'index' : 'fetch' : null, errorCode: syncStatus === 'failed' ? ['page_noindex', 'page_requires_rendering', 'cleanup_provider_401', 'page_too_large', 'robots_disallowed'][i] : undefined, indexedAt: now, lastSyncedAt: now, updatedAt: now }); };
    const collections = [1, 2].map(n => ({ id: `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`, name: `Selection QA ${n}`, aiEnabled: true, articleCount: 12, aiUsableCount: 12 }));
    const article = (c, i) => ({ id: `30000000-0000-4000-800${c}-${String(i).padStart(12, '0')}`, title: `Help ${c}.${i}`, shortId: 'qa0000', slug: 'qa', status: 'published', aiEnabled: true, indexStatus: 'ready', updatedAt: now, publishedAt: now, collection: { ...collections[c - 1] } });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('pageerror', e => result.pageErrors.push(e.message));
    await page.route('**/api/admin/ai-training', r => r.fulfill({ json: { sources: { help: { available: true, collectionCount: 2, articleCount: 24, aiUsableCount: 24 }, websites: [{ id, name: 'Selection QA', url: 'https://example.com', aiEnabled: true, inputType: 'website', status: syncing ? 'syncing' : failureCount ? 'attention' : 'ready', frequency: 'weekly', paused: false, excludes: '', nextRun: null, pages: { total: count, ready: count - failureCount, indexed: count, pending: 0, failed: failureCount, fetchFailed: fetchFailureCount, indexFailed: failureCount - fetchFailureCount }, activeRun: syncing ? { id: 'qa-run', scope: 'full', trigger: 'manual', status: 'running', total: singleRun ? 1 : count, processed: singleRun ? 0 : 41, added: 41, updated: 0, failed: 0, startedAt: now, finishedAt: null } : null, lastRun: failureCount ? { status: 'failed', scope: singleRun ? 'selected' : 'full', total: singleRun ? 1 : count, failed: failureCount } : null, lastFullRun: null, lastSyncedAt: now, lastFullSuccess: now }] } } }));
    await page.route('**/api/admin/help/collections?*', r => r.fulfill({ json: { data: collections } }));
    await page.route('**/api/admin/help/articles?*', async r => { helpRequests++; await new Promise(resolve => setTimeout(resolve, listDelay)); const q = new URL(r.request().url()).searchParams, c = collections.findIndex(c => c.id === q.get('collectionId')) + 1, p = Number(q.get('page') || 1), size = Number(q.get('pageSize') || 10); return r.fulfill({ json: { data: Array.from({ length: 12 }, (_, i) => article(c, i)).slice((p - 1) * size, p * size), pagination: { page: p, pageSize: size, total: 12 } } }); });
    await page.route(`**/api/admin/ai-training/websites/${id}/pages?*`, async (r) => {
        const q = new URL(r.request().url()).searchParams, p = Number(q.get('page')), size = Number(q.get('pageSize'));
        result.requests.push({ p, size, count });
        if (size === 100 && p === 2 && failSecond)
            return r.fulfill({ status: 503, json: { message: 'Unable to load pages. Please try again.' } });
        if (size === 100 && hold) {
            heldResolve();
            await new Promise(r => { release = r; });
        }
        await new Promise(r => setTimeout(r, size === 100 ? 200 : listDelay));
        await r.fulfill({ json: { data: Array.from({ length: count }, (_, i) => item(i)).slice((p - 1) * size, p * size), pagination: { page: p, pageSize: size, total: count } } });
    });
    const retryRoute = async r => {
        assert.equal(r.request().method(), 'POST');
        retryRequests++;
        retryStarted?.();
        await new Promise(resolve => { retryRelease = resolve; });
        if (rejectRetry) return r.fulfill({ status: 409, json: { message: 'A sync is already in progress.' } });
        const single = r.request().url().includes('/pages/');
        const indices = single ? [Number(r.request().url().split('/').at(-2).split('-').at(-1))] : [0, 1, 2, 3, 4];
        for (const index of indices) retryStates.set(index, 'pending');
        syncing = true;
        singleRun = single;
        await r.fulfill({ json: { runId: 'qa-retry-run' } });
    };
    await page.route('**/api/admin/ai-training/websites/pages/*/sync', retryRoute);
    await page.route(`**/api/admin/ai-training/websites/${id}/retry`, retryRoute);
    await page.goto('/dashboard/ai-training', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('[data-ai-training-websites-toggle]').click();
    const source = page.locator(`[data-source-id="${id}"]`), check = source.locator(':scope > div').first().getByRole('checkbox'), bulk = page.locator('[data-ai-training-bulk-scope="website"]');
    const waitCount = n => page.waitForFunction(n => { const e = document.querySelector('[data-ai-training-bulk-scope="website"]'); return n ? e?.textContent.includes(String(n)) : !e; }, n);
    // Normal expansion must use rows loaded with the overview, even on a slow network.
    count = 2;
    listDelay = 700;
    const firstRequest = result.requests.length;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-ai-training-sources]').waitFor();
    assert.equal(result.requests.length - firstRequest, 1, 'the website preview loads before headings are shown');
    const beforeExpand = result.requests.length;
    const helpBeforeExpand = helpRequests;
    await page.locator('[data-ai-training-websites-toggle]').click();
    const toggle = source.locator('[data-ai-training-source-toggle]');
    await toggle.click();
    assert.equal(await source.locator('[data-ai-training-document]').count(), 2);
    assert.equal(await source.locator('[data-ai-training-list-loading]').count(), 0);
    assert.equal(result.requests.length, beforeExpand, 'first expansion does not request rows');
    await toggle.click();
    await toggle.click();
    assert.equal(await source.locator('[data-ai-training-document]').count(), 2);
    await page.waitForTimeout(150);
    assert.equal(result.requests.length, beforeExpand, 'reopening unchanged website rows reuses the result');

    await page.locator('[data-ai-training-help-toggle]').click();
    const collection = page.locator('[data-collection-id]').first();
    const helpToggle = collection.locator('[data-ai-training-collection-toggle]');
    await helpToggle.click();
    assert.equal(await collection.locator('[data-ai-training-article]').count(), 10);
    assert.equal(await collection.locator('[data-ai-training-list-loading]').count(), 0);
    await helpToggle.click();
    await helpToggle.click();
    await page.waitForTimeout(150);
    assert.equal(helpRequests, helpBeforeExpand, 'first and repeated Help Center expansion use preloaded articles');
    result.checks.push('Website and Help Center first pages load before headings; first expansion and reopening do not fetch rows');
    const nextHelpPage = page.waitForResponse(r => r.url().includes('/api/admin/help/articles?') && new URL(r.url()).searchParams.get('page') === '2');
    await collection.getByRole('button', { name: 'Next page', exact: true }).click();
    const nextHelpResponse = await nextHelpPage;
    assert.equal(new URL(nextHelpResponse.url()).searchParams.get('pageSize'), '10');
    await collection.getByText('Help 1.10', { exact: true }).waitFor();
    assert.equal(await collection.locator('[data-ai-training-article]').count(), 2);
    const beforeBack = helpRequests;
    await collection.getByRole('button', { name: 'Previous page', exact: true }).click();
    await collection.getByText('Help 1.0', { exact: true }).waitFor();
    assert.equal(helpRequests, beforeBack, 'returning to page one reuses its preview');

    count = 3;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(id => document.querySelectorAll(`[data-source-id="${id}"] [data-ai-training-document]`).length === 3, id);
    result.checks.push('Later Help Center pages remain paginated; overview refresh replaces stale first-page previews');

    count = 79;
    listDelay = 20;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-ai-training-websites-toggle]').click();
    for (let cycle = 0; cycle < 4; cycle++) {
        const requests = result.requests.length, start = performance.now();
        await check.click();
        await waitCount(count);
        result.timings.push({ cycle, ms: Math.round(performance.now() - start), requests: result.requests.length - requests });
        await check.click();
        await waitCount(0);
    }
    await page.mouse.move(1400, 20);
    await page.waitForTimeout(250);
    const opacity = await check.evaluate(el => ({ opacity: getComputedStyle(el).opacity, focused: document.activeElement === el, focusVisible: el.matches(':focus-visible') }));
    result.idleOpacity = opacity;
    if (phase !== 'baseline') {
        assert.equal(opacity.opacity, '0');
        assert.ok(result.timings.slice(1).every(x => x.requests === 0));
        result.checks.push('Repeated select-all reuses loaded scope; pointer focus does not keep idle checkbox visible');
    }
    await source.locator('[data-ai-training-document]').first().hover();
    const rowCheck = source.locator('[data-ai-training-document]').first().getByRole('checkbox');
    await rowCheck.click();
    await page.mouse.move(1400, 20);
    await page.waitForTimeout(250);
    const allVisible = await source.locator('[data-ai-training-document] [role="checkbox"]').evaluateAll(es => es.every(e => getComputedStyle(e).opacity === '1'));
    assert.ok(allVisible);
    await bulk.getByRole('button', { name: 'Clear', exact: true }).click();
    await waitCount(0);
    result.checks.push('Selection mode shows all page checkboxes and Clear exits it');
    // Start a fresh large scope; test cross-page selection without touching stored data.
    count = 800;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-ai-training-websites-toggle]').click();
    const start = performance.now();
    await check.click();
    await waitCount(count);
    result.largeMs = Math.round(performance.now() - start);
    await bulk.getByRole('button', { name: 'Clear', exact: true }).click();
    await waitCount(0);
    result.checks.push('All 800 items selected across eight API pages');
    if (phase !== 'baseline') {
        count = 123;
        failSecond = true;
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('[data-ai-training-websites-toggle]').click();
        await check.click();
        await source.getByRole('alert').waitFor();
        assert.equal(await bulk.count(), 0);
        assert.equal(await check.getAttribute('aria-checked'), 'false');
        result.checks.push('A failed batch does not leave a partial selection');
        failSecond = false;
        hold = true;
        held = new Promise(r => heldResolve = r);
        await check.click();
        await held;
        await page.waitForTimeout(50);
        assert.equal(await check.isEnabled(), true);
        assert.equal(await check.getAttribute('aria-busy'), 'true');
        await check.click();
        hold = false;
        release();
        await page.waitForTimeout(400);
        assert.equal(await bulk.count(), 0);
        assert.equal(await check.getAttribute('aria-checked'), 'false');
        result.checks.push('Pending selection can be cancelled and late responses cannot restore it');
        await source.locator('[data-ai-training-document]').first().hover();
        await source.locator('[data-ai-training-document]').first().getByRole('checkbox').click();
        hold = true;
        held = new Promise(resolve => { heldResolve = resolve; });
        await check.click();
        await held;
        await bulk.getByRole('button', { name: 'Clear', exact: true }).click();
        hold = false;
        release();
        await page.waitForTimeout(400);
        assert.equal(await bulk.count(), 0);
        assert.equal(await check.getAttribute('aria-busy'), null);
        result.checks.push('Clear also cancels a pending select-all while individual rows are selected');
        await page.locator('[data-ai-training-help-toggle]').click();
        const helpBulk = page.locator('[data-ai-training-bulk-scope="help"]');
        for (const c of collections) {
            const heading = page.locator(`[data-collection-id="${c.id}"]`).locator(':scope > div').first().getByRole('checkbox');
            await heading.click();
            await page.waitForFunction(id => {
                const check = document.querySelector(`[data-collection-id="${id}"] [role="checkbox"]`);
                return check?.getAttribute('aria-checked') === 'true' && !check.hasAttribute('aria-busy');
            }, c.id);
        }
        assert.match(await helpBulk.innerText(), /24/);
        await helpBulk.getByRole('button', { name: 'Clear', exact: true }).click();
        result.checks.push('Selection still spans Help Center collections');
    }
    showErrors = true;
    count = 79;
    failureCount = 5;
    fetchFailureCount = 4;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-ai-training-websites-toggle]').click();
    await source.locator('[data-ai-training-source-toggle]').click();
    await source.locator('[data-ai-training-document]').first().waitFor();
    const errors = source.locator('[data-ai-training-content-title] .text-destructive');
    await errors.first().waitFor();
    assert.match(await errors.nth(0).innerText(), /Unable to read page/);
    assert.equal(await errors.nth(1).innerText(), await errors.nth(0).innerText());
    assert.match(await errors.nth(2).innerText(), /Sync failed. Try again later/);
    assert.match(await errors.nth(3).innerText(), /Page content is too long/);
    assert.match(await errors.nth(4).innerText(), /Crawling is blocked by this website/);
    const failedRows = source.locator('[data-ai-training-document]');
    assert.equal(await failedRows.nth(0).locator('[data-sync-state]').innerText(), 'Fetch failed');
    assert.equal(await failedRows.nth(2).locator('[data-sync-state]').innerText(), 'Index failed');
    assert.doesNotMatch(await source.innerText(), /full rendering|content retrieval setting|remote browser service/i);
    assert.ok(await errors.evaluateAll(elements => elements.every(el => getComputedStyle(el).whiteSpace !== 'nowrap')));
    result.checks.push('Current and persisted failure codes show readable explanations without removed settings');
    // All writes below are intercepted: delayed retry requests must update the row immediately.
    const firstRow = failedRows.nth(0), secondRow = failedRows.nth(1);
    const rowStatus = row => row.locator('[data-sync-state]');
    const waitStatus = async (row, status) => {
        await page.waitForFunction(({ id, status }) => document.querySelector(`[data-document-id="${id}"] [data-sync-state]`)?.getAttribute('data-sync-state') === status, { id: await row.getAttribute('data-document-id'), status });
    };
    const waitIdle = () => page.waitForFunction(() => !document.querySelector('[data-ai-training-source-sync]')?.disabled);
    let started = new Promise(resolve => { retryStarted = resolve; });
    await firstRow.getByRole('button', { name: 'Retry: Selection page 0', exact: true }).click();
    await started;
    await waitStatus(firstRow, 'pending');
    assert.equal(await rowStatus(firstRow).innerText(), 'Pending');
    assert.equal(await firstRow.locator('[data-ai-training-content-title] .text-destructive').count(), 0);
    assert.equal(await rowStatus(secondRow).innerText(), 'Fetch failed');
    assert.equal(await firstRow.getByRole('button', { name: 'Sync page: Selection page 0', exact: true }).isDisabled(), true);
    assert.equal(await firstRow.locator('[class*="animate-spin"]').count(), 1);
    assert.equal(await firstRow.getByRole('button', { name: 'Preview: Selection page 0', exact: true }).isEnabled(), true, 'an existing index stays available during retry');
    listDelay = 700;
    retryRelease();
    await page.waitForTimeout(200);
    assert.equal(await rowStatus(firstRow).innerText(), 'Pending', 'refreshing does not reveal the old failure');
    await page.waitForTimeout(1000);
    assert.equal(await rowStatus(firstRow).innerText(), 'Pending');
    assert.equal(await source.getByRole('progressbar').count(), 0, 'a single-page retry has no source progress bar');
    retryStates.set(0, 'processing');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await waitStatus(firstRow, 'indexing');
    retryStates.set(0, 'ready');
    syncing = false;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await waitStatus(firstRow, 'ready');
    await waitIdle();
    result.checks.push('Single-page retry immediately shows Pending and a spinner, hides the old error, then follows processing and success without a source progress bar');

    // A rejected request restores the original result and does not leave a spinner behind.
    rejectRetry = true;
    started = new Promise(resolve => { retryStarted = resolve; });
    await secondRow.getByRole('button', { name: 'Retry: Selection page 1', exact: true }).click();
    await started;
    await waitStatus(secondRow, 'pending');
    retryRelease();
    await waitStatus(secondRow, 'failed');
    assert.equal(await rowStatus(secondRow).innerText(), 'Fetch failed');
    await secondRow.getByText('Unable to read page. Try again later.', { exact: true }).waitFor();
    assert.equal(await secondRow.locator('[class*="animate-spin"]').count(), 0);
    assert.equal(await secondRow.getByRole('button', { name: 'Retry: Selection page 1', exact: true }).isEnabled(), true);
    assert.equal(retryRequests, 2);
    result.checks.push('Rejected retry restores the failure message and enables retry again');

    // Later pages load after the refreshed page-one preview; never flash the previous failure.
    rejectRetry = false;
    retryStates.set(11, 'failed');
    await source.getByRole('button', { name: 'Next page', exact: true }).click();
    const laterRow = source.locator('[data-document-id="40000000-0000-4000-8001-000000000011"]');
    await waitStatus(laterRow, 'failed');
    started = new Promise(resolve => { retryStarted = resolve; });
    await laterRow.getByRole('button', { name: 'Retry: Selection page 11', exact: true }).click();
    await started;
    await waitStatus(laterRow, 'pending');
    await laterRow.evaluate(el => {
        window.retryObservedStates = [];
        window.retryObserver = new MutationObserver(() => window.retryObservedStates.push(el.querySelector('[data-sync-state]')?.getAttribute('data-sync-state')));
        window.retryObserver.observe(el, { attributes: true, childList: true, subtree: true });
    });
    const laterRefresh = page.waitForRequest(r => r.url().includes(`/websites/${id}/pages?`) && new URL(r.url()).searchParams.get('page') === '2');
    retryRelease();
    await laterRefresh;
    await page.waitForTimeout(100);
    assert.equal(await rowStatus(laterRow).innerText(), 'Pending');
    await page.waitForTimeout(800);
    assert.equal(await rowStatus(laterRow).innerText(), 'Pending');
    const observed = await page.evaluate(() => { window.retryObserver.disconnect(); return window.retryObservedStates; });
    assert.ok(!observed.includes('failed'), 'refreshing a later page must not restore the old failure');
    retryStates.set(11, 'ready');
    syncing = false;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await waitStatus(laterRow, 'ready');
    await waitIdle();
    await source.getByRole('button', { name: 'Previous page', exact: true }).click();
    await source.getByText('Selection page 0', { exact: true }).waitFor();
    await waitStatus(firstRow, 'ready');
    result.checks.push('Later-page retries retain feedback while their separate row request is loading');

    // Retrying all failures must update only failed pages, keeping successful pages unchanged.
    rejectRetry = false;
    listDelay = 20;
    started = new Promise(resolve => { retryStarted = resolve; });
    await source.locator('[data-ai-training-retry-failed]').click();
    await started;
    await waitStatus(secondRow, 'pending');
    assert.equal(await rowStatus(firstRow).innerText(), 'Indexed');
    for (const index of [2, 3, 4]) await waitStatus(failedRows.nth(index), 'pending');
    retryRelease();
    await source.getByRole('progressbar').waitFor();
    retryStates.set(1, 'failed');
    syncing = false;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await waitStatus(secondRow, 'failed');
    result.checks.push('Source retry updates affected rows immediately, shows batch progress, and reports a subsequent failure');
    retryStates.clear();
    singleRun = false;
    for (const scenario of [
        { total: 15, failed: 4, fetch: 3, single: false, badge: 'partial' },
        { total: 79, failed: 79, fetch: 39, single: false, badge: 'failed' },
        { total: 79, failed: 1, fetch: 1, single: true, badge: 'partial' },
        { total: 79, failed: 2, fetch: 0, single: false, badge: 'partial' },
    ]) {
        count = scenario.total;
        failureCount = scenario.failed;
        fetchFailureCount = scenario.fetch;
        singleRun = scenario.single;
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('[data-ai-training-websites-toggle]').click();
        const badge = source.locator('[data-ai-training-source-toggle] [data-sync-state]');
        assert.equal(await badge.getAttribute('data-sync-state'), scenario.badge);
        assert.equal(await badge.innerText(), `${scenario.badge === 'partial' ? 'Partially failed' : 'Sync failed'} (${scenario.failed}/${scenario.total})`);
        const summary = source.locator('[data-ai-training-failure-summary]');
        const expected = [
            `${scenario.failed} pages failed`,
            scenario.fetch > 0 ? `Fetch failed ${scenario.fetch}` : null,
            scenario.failed > scenario.fetch ? `Index failed ${scenario.failed - scenario.fetch}` : null,
        ].filter(Boolean).join(' · ');
        assert.equal(await summary.innerText(), expected);
        assert.equal(await summary.getAttribute('title'), expected);
        if (scenario.total === 15) {
            await page.setViewportSize({ width: 900, height: 1000 });
            await page.mouse.move(0, 0);
            const layout = await summary.evaluate(el => ({ width: el.clientWidth, full: el.scrollWidth, overflow: getComputedStyle(el).textOverflow, whitespace: getComputedStyle(el).whiteSpace }));
            assert.ok(layout.width > 0 && layout.full > layout.width);
            assert.equal(layout.overflow, 'ellipsis');
            assert.equal(layout.whitespace, 'nowrap');
            await summary.hover();
            assert.equal(await source.locator('[data-ai-training-source-actions]').evaluate(el => getComputedStyle(el).opacity), '1');
            await page.setViewportSize({ width: 1440, height: 1000 });
        }
    }
    result.checks.push('Source failure fractions and fetch/index counts are accurate; narrow summaries truncate with full hover text');
    count = 79;
    failureCount = 0;
    fetchFailureCount = 0;
    singleRun = false;
    syncing = true;
    for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('[data-ai-training-websites-toggle]').click();
        const bar = source.getByRole('progressbar');
        await bar.waitFor();
        const title = source.locator('[data-ai-training-source-toggle] strong');
        const barBox = await bar.boundingBox(), titleBox = await title.boundingBox(), sourceBox = await source.boundingBox();
        assert.ok(Math.abs(barBox.x - titleBox.x) <= 1, 'progress starts at the source title column');
        assert.ok(barBox.x + barBox.width <= sourceBox.x + sourceBox.width - 15, 'progress stays inside list right padding');
        const menuBox = await source.locator('[data-ai-training-source-menu-icon]').boundingBox();
        assert.ok(Math.abs(menuBox.x + menuBox.width - (barBox.x + barBox.width)) <= 1, 'progress ends at the ellipsis icon right edge');
        await source.locator('[data-ai-training-source-toggle]').click();
        await source.locator('[data-ai-training-content-title]').first().waitFor();
        const rowBox = await source.locator('[data-ai-training-content-title]').first().boundingBox();
        assert.ok(Math.abs(barBox.x - rowBox.x) <= 1, 'progress aligns with page titles');
        result.checks.push(`Progress aligns with source/page titles and stays inside the list at ${width}px`);
    }
    assert.deepEqual(result.pageErrors, []);
    result.passed = true;
}
catch (e) {
    result.passed = false;
    result.error = e.stack;
    process.exitCode = 1;
}
finally {
    if (process.env.AI_TRAINING_SELECTION_RESULTS)
        await writeFile(process.env.AI_TRAINING_SELECTION_RESULTS, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    await browser.close();
}
