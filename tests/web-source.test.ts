import assert from 'node:assert/strict'
import { test } from 'node:test'
import { webSourceConcurrency } from '../server/lib/web-source/concurrency'
import { parsePreparedWebSource, webSourceCleanupInput } from '../server/lib/web-source/prepare'
import { webSourcePageTree, flattenWebSourcePageTree, webSourceInputTypeForUrl } from '../shared/utils/web-source-pages'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite/vector'
import type { Pool } from 'pg'
import { webSourceDiscovery, webSourceInput, webSourceSettings, webSourceIndividualImport } from '../shared/schemas/web-source'


import { CrawlError, normalizeWebSourceUrl, isPublicIPv4, withinWebSourceScope } from '../server/lib/web-source/fetch'
import { extractWebSourceContent, inspectWebSourcePage } from '../server/lib/web-source/content'
import { processWebSourcePage } from '../server/lib/web-source/page'
import { parseWebSourceRobots, webSourceRobotsAllows } from '../server/lib/web-source/robots'
import { discoverWebSourcePages, parseWebSourceSitemap } from '../server/lib/web-source/discovery'
import { importIndividualWebSourcePages, createWebSource, readWebSourcePage, removeWebSource, removeWebSourceOrganization, updateWebSourceSettings, syncWebSourcePage, removeWebSourcePage, syncWebSourcePages, removeWebSourcePages } from '../server/services/web-source'
import { listAiTrainingWebsites, listAiTrainingWebsitePages } from '../server/services/ai-training'
import { drizzle } from 'drizzle-orm/pglite'
import { listManagementArticles } from '../server/services/help-center-queries'
import { aiTrainingAiEligible, aiTrainingProcessingStatus, aiTrainingMatchesIndexFilter, aiTrainingMatchesHelpPublication, aiTrainingWebsiteStatus, aiTrainingRunStatus } from '../shared/utils/ai-training'
import { webSourceTransaction, startWebSourceRun } from '../server/lib/web-source/jobs'
import { runNextWebSourceTask } from '../server/lib/web-source/worker'
import { createWebSourceTestDatabase } from './fixtures/web-source-database'
import { searchWebPages } from '../server/lib/web-source/search'

test('website concurrency defaults to eight and retains the explicit lower cap', () => {
  const previous = process.env.WEB_SOURCE_CONCURRENCY
  try {
    delete process.env.WEB_SOURCE_CONCURRENCY
    assert.equal(webSourceConcurrency(), 8)
    process.env.WEB_SOURCE_CONCURRENCY = '4'
    assert.equal(webSourceConcurrency(), 4)
    process.env.WEB_SOURCE_CONCURRENCY = '9'
    assert.equal(webSourceConcurrency(), 8)
  } finally {
    if (previous === undefined) delete process.env.WEB_SOURCE_CONCURRENCY
    else process.env.WEB_SOURCE_CONCURRENCY = previous
  }
})

test('URL normalization, network ranges and crawl scope', () => {
  assert.equal(normalizeWebSourceUrl('example.com/docs/?utm_source=ad&b=2&a=1#top'), 'https://example.com/docs/?a=1&b=2')
  for (const url of ['file:///etc/passwd', 'http://localhost', 'http://127.1', 'http://2130706433', 'http://user:pass@example.com', 'http://example.com:8080', 'http://[::1]']) assert.throws(() => normalizeWebSourceUrl(url))
  for (const ip of ['127.0.0.1', '10.0.0.2', '169.254.169.254', '172.16.0.1', '192.168.1.2', '100.64.0.1', '198.18.0.1', '224.0.0.1', '0.0.0.0']) assert.equal(isPublicIPv4(ip), false, ip)
  assert.equal(isPublicIPv4('1.1.1.1'), true)
  assert.equal(withinWebSourceScope('https://example.com/docs/setup', 'https://example.com/docs', 'website'), true)
  assert.equal(withinWebSourceScope('https://example.com/docs-evil', 'https://example.com/docs', 'website'), false)
  assert.equal(withinWebSourceScope('https://other.example.com/docs', 'https://example.com/docs', 'website'), false)
})

test('robots matching, Sitemap index and XML entity rejection', () => {
  const robots = parseWebSourceRobots('User-agent: *\nDisallow: /private\nAllow: /private/public\nSitemap: https://example.com/map.xml')
  assert.equal(webSourceRobotsAllows(robots, 'https://example.com/private/a'), false)
  assert.equal(webSourceRobotsAllows(robots, 'https://example.com/private/public/a'), true)
  assert.deepEqual(robots.sitemaps, ['https://example.com/map.xml'])
  const specific = parseWebSourceRobots('User-agent: *\nDisallow: /\nUser-agent: FeedLogBot\nAllow: /')
  assert.equal(webSourceRobotsAllows(specific, 'https://example.com/start'), true)
  assert.deepEqual(parseWebSourceSitemap('<sitemapindex><sitemap><loc>https://example.com/a.xml</loc></sitemap></sitemapindex>'), { index: true, urls: ['https://example.com/a.xml'] })
  assert.deepEqual(parseWebSourceSitemap('<urlset><url><loc>https://example.com/?a=1&amp;b=2</loc></url></urlset>').urls, ['https://example.com/?a=1&b=2'])
  assert.throws(() => parseWebSourceSitemap('<!DOCTYPE foo [<!ENTITY x SYSTEM "file:///etc/passwd">]><urlset/>'), /invalid_sitemap/)
})

test('HTML cleaning retains answer evidence, tables, code, headings and absolute links', () => {
  const page = extractWebSourceContent(`<html><head><title>Configuration</title><script>SECRET_SCRIPT</script></head><body><nav>NAVIGATION_NOISE</nav><main>
    <h1>Installation</h1><p>Install the website widget to collect customer questions and feedback.</p>
    <p hidden>HIDDEN_SECRET</p><h2>Limits</h2><table><tr><th>Plan</th><th>Limit</th></tr><tr><td>Pro</td><td>200</td></tr></table>
    <pre><code>npm install widget\nconst ready = true;</code></pre><a href="/guide">Read the guide</a></main><footer>FOOTER_NOISE</footer></body></html>`, 'https://example.com/docs')
  assert.equal(page.title, 'Installation')
  for (const evidence of ['## Limits', 'Pro | 200', 'npm install widget', 'const ready = true;', '[Read the guide](https://example.com/guide)']) assert.ok(page.content.includes(evidence), evidence)
  for (const noise of ['SECRET_SCRIPT', 'NAVIGATION_NOISE', 'HIDDEN_SECRET', 'FOOTER_NOISE']) assert.equal(page.content.includes(noise), false)

})

test('public noindex pages import while explicit crawler directives remain enforced', async () => {
  const body = '<main><h1>Refund policy</h1><p>Contact customer support within seven days to request a refund.</p></main>'
  const response = { url: 'https://example.com/policy', status: 200, headers: { 'content-type': 'text/html' }, body }
  for (const meta of ['<meta name="robots" content="noindex">', '<meta name="robots" content="none">', '<meta name="googlebot" content="noindex">']) {
    const page = await processWebSourcePage({ ...response, body: meta + body }, {})
    assert.ok(page.content.content.includes('within seven days'))
  }
  for (const header of ['noindex', 'none', 'noindex, nofollow', 'googlebot: noindex', 'feedlogbot: follow, googlebot: noindex']) {
    const page = await processWebSourcePage({ ...response, headers: { ...response.headers, 'x-robots-tag': header } }, {})
    assert.ok(page.content.content.includes('within seven days'), header)
  }
  await assert.rejects(processWebSourcePage({ ...response, body: '<meta name="FeedLogBot" content="noindex">' + body }, {}), /page_noindex/)
  for (const header of ['FeedLogBot: noindex', 'feedlogbot: nofollow, noindex', 'googlebot: follow, feedlogbot: none', 'feedlogbot: follow, max-snippet: 0, noindex']) {
    await assert.rejects(processWebSourcePage({ ...response, headers: { ...response.headers, 'x-robots-tag': header } }, {}), /page_noindex/, header)
  }
})

test('empty tool state is excluded while published limits, pricing, instructions and code remain', () => {
  const page = extractWebSourceContent(`<main><h1>Document checker</h1>
    <div><textarea>Draft user input</textarea><div role="button" title="Paste your document here">Paste your document here</div><span>Words: <span>0</span>/<span>1000</span><button aria-label="Grammar checks cost 1 credit per 500 words."><svg></svg></button></span></div>
    <span>Palavras: 0/1000</span><span>語数: 0/1000</span><span>字符数：0/1000</span>
    <div><textarea></textarea><span>0/100000</span></div><table><tr><th>Ratio</th></tr><tr><td>0/100000</td></tr></table>
    <div><span>Detection Result</span><div><span>Authoritative Conclusion</span><div>--% AI Generated</div><div>--% Human</div></div></div>
    <p>Checks cost 1 credit per 100 words; plagiarism costs 2 credits per 500 words.</p>
    <h2>Usage limits</h2><p>Guest users can check documents 5 times per day; additional usage requires a paid plan.</p>
    <h3>Step 3: Review Detection Results</h3><p>Read the report before rewriting your document.</p>
    <pre><code>Words: 0/1000\n--% Human</code></pre></main>`, 'https://example.com')
  for (const fact of ['1 credit per 100 words', '2 credits per 500 words', 'Grammar checks cost 1 credit per 500 words.', '5 times per day', 'paid plan', 'Step 3: Review Detection Results', '```\nWords: 0/1000\n--% Human']) assert.ok(page.content.includes(fact), fact)
  for (const noise of ['Draft user input', 'Paste your document here', 'Authoritative Conclusion', '--% AI Generated', 'Palavras: 0/1000', '語数: 0/1000', '字符数：0/1000']) assert.ok(!page.content.includes(noise), noise)
  assert.equal(page.content.match(/Words: 0\/1000/g)?.length, 1)
  assert.equal(page.content.match(/0\/100000/g)?.length, 1, 'a real table ratio stays; an input counter does not')
})

test('static product disclosures retain facts without rendering or popup content', async () => {
  const body = `<html><body><header><nav>GLOBAL_NAVIGATION_NOISE</nav></header><main>
    <section><header><h1>Workspace billing</h1><p>All plans include unlimited readers and optional paid editor seats.</p></header>
    <div><h3>Step 2: Review the report</h3><p style="display:none">Review sentence-level results before choosing whether to rewrite your document.</p></div>
    <div class="accordion"><h3><button id="refund-question" aria-expanded="false" aria-controls="refund-answer">When are refunds available?</button></h3>
      <div hidden style="display:none"><div id="refund-answer" role="region" aria-labelledby="refund-question" hidden>
        <p>Refunds are available only if no paid credits were used in the current billing period.</p></div></div></div>
    <button aria-describedby="credit-help" aria-label="Checks cost 1 credit per 100 words; plagiarism costs 2 credits per 500 words."><svg></svg></button>
    <div id="credit-help" role="tooltip" style="display:none">Checks cost 1 credit per 100 words; plagiarism costs 2 credits per 500 words.</div>
    <p hidden>Unrelated hidden internal text must never become published knowledge.</p>
    <p>Contact <a data-cfemail="127a777e6252776a737f627e773c717d7f">[email protected]</a> for billing support.</p>
    <button>Buy a plan</button></section></main>
    <div role="dialog"><h2>POPUP_ANNOUNCEMENT_NOISE</h2><p>Temporary promotion that does not belong in reference material.</p></div></body></html>`
  const response = { url: 'https://example.com/billing', status: 200, headers: { 'content-type': 'text/html' }, body }
  const page = await processWebSourcePage(response, { })
  assert.equal(page.fetchMode, 'http')
  for (const fact of ['# Workspace billing', 'unlimited readers', 'Review sentence-level results', '### When are refunds available?', 'only if no paid credits were used', 'Checks cost 1 credit per 100 words; plagiarism costs 2 credits per 500 words.', 'help@example.com']) {
    assert.ok(page.content.content.includes(fact), fact)
  }
  for (const noise of ['GLOBAL_NAVIGATION_NOISE', 'POPUP_ANNOUNCEMENT_NOISE', 'Unrelated hidden internal text', 'Buy a plan', '### ###']) assert.ok(!page.content.content.includes(noise), noise)
  assert.equal(page.content.content.match(/Checks cost 1 credit per 100 words/g)?.length, 1, 'referenced tooltip facts are not duplicated')
})

test('unlabelled static question-answer disclosures retain billing facts without exposing unrelated hidden content', async () => {
  const body = `<html><body><main><h1>Billing</h1><p>Review the published billing rules for your account.</p>
    <div><span class="cursor-pointer"><h3>Do credit packs expire?</h3></span>
      <div style="display:none;max-height:0"><div>Credit packs take effect immediately and never expire.</div></div></div>
    <div><button>Which balance is used first?</button>
      <div hidden>Monthly subscription credits are prioritized before credit packs.</div></div>
    <div><span role="button">取消订阅后多久失效？</span>
      <div aria-hidden="true">Your current plan remains active until the end of the billing cycle.</div></div>
    <div><span>Non-interactive heading?</span><div hidden>NON_INTERACTIVE_SECRET</div></div>
    <div><button>Where do I sign in?</button><div hidden><form><input type="password">HIDDEN_FORM</form></div></div>
    <div hidden>UNRELATED_HIDDEN_CONTENT</div></main>
    <nav><div><button>Need a promotion?</button><div hidden>NAVIGATION_PROMOTION</div></div></nav>
    <div role="dialog"><div><button>Read our announcement?</button><div hidden>DIALOG_PROMOTION</div></div></div>
    </body></html>`
  const parsed = await processWebSourcePage({ url: 'https://example.com/pricing', status: 200, headers: { 'content-type': 'text/html' }, body },
    { })
  assert.equal(parsed.fetchMode, 'http')
  for (const fact of ['never expire', 'Monthly subscription credits are prioritized', 'end of the billing cycle']) assert.ok(parsed.content.content.includes(fact), fact)
  for (const noise of ['NON_INTERACTIVE_SECRET', 'HIDDEN_FORM', 'UNRELATED_HIDDEN_CONTENT', 'NAVIGATION_PROMOTION', 'DIALOG_PROMOTION']) assert.ok(!parsed.content.content.includes(noise), noise)
})

test('content selection ignores modal landmarks and retains article headings and short sibling facts', () => {
  const content = extractWebSourceContent(`<html><body><main>
    <header><nav>BREADCRUMB_NOISE</nav><h1>Installation</h1></header>
    <p>${'Configure the widget to collect customer feedback and notifications. '.repeat(30)}</p>
    </main><section><h2>Pricing</h2><p>$9 per month.</p></section>
    <section><h2>Refunds</h2><p>Within 7 days.</p></section>
    <div role="dialog"><main><h1>MODAL_NOISE</h1><p>${'POPUP_NOISE '.repeat(200)}</p></main></div>
    <footer><a href="/tools">FOOTER_MENU_NOISE</a><span>Copyright FOOTER_COPYRIGHT_NOISE</span>
      <a href="mailto:support@example.com?subject=Help">Contact support</a><a href="tel:+12025550123">Call us</a>
      <address>10 Example Street</address><div hidden><a href="mailto:hidden@example.com">Hidden contact</a></div>
      <div role="dialog"><a href="mailto:popup@example.com">Popup contact</a></div></footer>
    <footer hidden><a href="mailto:hidden-footer@example.com">Hidden footer contact</a></footer></body></html>`, 'https://example.com/docs')
  assert.equal(content.title, 'Installation')
  for (const fact of ['# Installation', '## Pricing', '$9 per month.', '## Refunds', 'Within 7 days.', 'support@example.com', '+12025550123', '10 Example Street']) assert.ok(content.content.includes(fact), fact)
  for (const noise of ['BREADCRUMB_NOISE', 'MODAL_NOISE', 'POPUP_NOISE', 'FOOTER_MENU_NOISE', 'FOOTER_COPYRIGHT_NOISE', 'hidden@example.com', 'popup@example.com', 'hidden-footer@example.com']) assert.ok(!content.content.includes(noise), noise)
})

test('table serialization emits descriptive controls once and excludes hidden cells', () => {
  const content = extractWebSourceContent(`<main><h1>Account usage</h1><p>Usage is billed according to the following limits and conditions.</p>
    <table><tr><th>Tool</th><th>Credits</th></tr><tr><td>AI Checker</td>
      <td><button aria-describedby="credits">Info</button><span id="credits" role="tooltip">AI Checker costs one credit per hundred words.</span></td>
      <td hidden>PRIVATE_CELL</td></tr></table></main>`, 'https://example.com/billing').content
  assert.match(content, /AI Checker \| AI Checker costs one credit per hundred words\./)
  assert.equal(content.match(/costs one credit/g)?.length, 1)
  assert.ok(!content.includes('PRIVATE_CELL'))
})

test('server-rendered tab and reverse-labelled FAQ panels retain complete prose and commands', () => {
  const html = `<main><h1>Installation and billing</h1>
    <button id="tab-npm" role="tab" aria-controls="panel-npm">npm</button><div id="panel-npm" role="tabpanel" hidden><pre><code>npm install example-widget</code></pre></div>
    <button id="tab-pnpm" role="tab" aria-controls="panel-pnpm">pnpm</button><div id="panel-pnpm" role="tabpanel" hidden><pre><code>pnpm add example-widget</code></pre></div>
    <div hidden="until-found"><ul><li>On Windows, use the documented loopback address if local DNS is slow.</li></ul></div>
    <div><button aria-expanded="false"><h3>Can I use these images commercially?</h3></button><p>Commercial use depends on the selected model and its license terms.</p></div>
    <button id="billing-question" aria-expanded="false">Can I cancel my subscription?</button>
    <div role="region" aria-labelledby="billing-question" style="display:none"><p>You can cancel anytime; access continues until the end of the current billing period.</p></div>
  </main>`
  const content = extractWebSourceContent(html, 'https://example.com/docs').content
  for (const fact of ['npm install example-widget', 'pnpm add example-widget', '### Can I cancel my subscription?', '### Can I use these images commercially?', 'access continues until the end of the current billing period', 'use the documented loopback address if local DNS is slow']) assert.ok(content.includes(fact), fact)
  assert.ok(!content.includes('### ###'), 'headings inside disclosure buttons retain one level marker')
  assert.equal(inspectWebSourcePage(html, 'https://example.com/docs').needsBrowser, false)
  assert.equal(inspectWebSourcePage(html.replace('aria-labelledby="billing-question"', 'aria-labelledby="unavailable"'), 'https://example.com/docs').needsBrowser, false, 'unconnected controls without a declared target do not force rendering')
  const dynamic = '<main><h1>Support</h1><p>Find answers to your product and billing questions below.</p><button aria-expanded="false" aria-controls="remote-answer">How do refunds work?</button><div id="remote-answer"></div></main>'
  assert.equal(inspectWebSourcePage(dynamic, 'https://example.com/docs').needsBrowser, true, 'an empty declared panel is not mistaken for complete static content')
})

test('SSR product copy is readable with menus, selects and promotional popovers', async () => {
  const html = `<html><body><div><button aria-expanded="false" aria-controls="sidebar-links">Viewer Tools</button><div id="sidebar-links" hidden><a href="/tool">Other tool</a></div></div>
    <main><h1>Story viewer</h1><p>View and download public stories anonymously without providing an account password.</p>
    <button role="combobox" aria-expanded="false" aria-controls="select-options">Select tone</button>
    <button aria-label="About partner tools" aria-expanded="false" aria-controls="partner-info"></button>
    <div id="partner-info" hidden><p>Some promotional information about a different product.</p></div>
    <h2>How it works</h2><p>Enter a public username and select a story to view or download.</p></main></body></html>`
  const response = { url: 'https://example.com/story-viewer', status: 200, headers: { 'content-type': 'text/html' }, body: html }
  assert.equal(inspectWebSourcePage(html, response.url).needsBrowser, false)
  const page = await processWebSourcePage(response, { collectData: true })
  assert.equal(page.fetchMode, 'http')
  assert.ok(page.content.content.includes('without providing an account password'))
  assert.ok(page.content.content.includes('select a story to view or download'))
  assert.ok(!page.content.content.includes('Some promotional information'))
})

test('unreadable HTML is rejected without offering a rendering mode', async () => {
  const response = { url: 'https://example.com/guide', status: 200, headers: { 'content-type': 'text/html' }, body: '<main><h1>Guide</h1></main>' }
  await assert.rejects(processWebSourcePage(response), /page_requires_rendering/)
  for (const schema of [webSourceDiscovery, webSourceIndividualImport, webSourceSettings]) {
    const input = schema.parse({ url: response.url, urls: [response.url], frequency: 'weekly', paused: false, renderMode: 'browser' })
    assert.equal('renderMode' in input, false, 'old clients cannot enable a rendering strategy')
  }
})

test('source sync stays HTTP-only, rejects JS shells and keeps the previous indexed body', async () => {
  const { db, pool, orgId } = await createWebSourceTestDatabase()
  let dynamic = false
  const requestedHeaders: Record<string, string>[] = []
  const html = '<main><h1>Configuration</h1><p>Install the widget and configure notifications to collect customer questions.</p></main>'
  const fetcher = async (url: string, headers: Record<string, string> = {}) => {
    if (!url.endsWith('/robots.txt')) requestedHeaders.push(headers)
    return { url, status: 200, headers: { 'content-type': 'text/html', etag: 'shell' }, body: url.endsWith('/robots.txt') ? 'User-agent: *\nAllow: /' : dynamic ? '<main>Loading...</main><script src="/app.js"></script>' : html }
  }
  const options = { fetcher, prepare: async (page: { content: string }) => ({ content: page.content, summary: 'Widget configuration.', keywords: ['widget'], evidence: ['configure notifications'] }), embed: async (inputs: string[]) => inputs.map(() => [1, ...Array(767).fill(0)]) }
  try {
    const { id } = await createWebSource(pool, orgId, webSourceInput.parse({ url: 'https://example.com', pages: [{ title: '', url: 'https://example.com/guide' }], renderMode: 'browser' }))
    assert.equal((await pool.query("SELECT column_name FROM information_schema.columns WHERE (table_name='ai_training_website' AND column_name IN ('render_mode','enable_on_sync')) OR (table_name='web_page' AND column_name='enabled')")).rows.length, 0)
    await pool.query("UPDATE ai_training_web_page SET metadata=metadata||jsonb_build_object('fetchMode','browser') WHERE website_id=$1", [id])
    assert.equal((await runNextWebSourceTask(pool, options)).ready, true)
    dynamic = true
    await webSourceTransaction(pool, client => startWebSourceRun(client, orgId, id, 'manual'))
    const result = await runNextWebSourceTask(pool, options)
    assert.equal(result.code, 'page_requires_rendering')
    const current = (await pool.query(`SELECT sync_status,indexed_at,metadata FROM ai_training_web_page WHERE website_id=$1`, [id])).rows[0]
    assert.equal(current.sync_status, 'failed')
    assert.ok(current.indexed_at)
    assert.ok(current.metadata.content.includes('configure notifications'), 'failed JS-only updates retain the usable body')
    dynamic = false
    await webSourceTransaction(pool, client => startWebSourceRun(client, orgId, id, 'manual'))
    assert.equal((await runNextWebSourceTask(pool, options)).ready, true)
    assert.equal(requestedHeaders.at(-1)?.['If-None-Match'], 'shell', 'a failed update preserves the last usable HTTP validators')
    assert.equal((await pool.query(`SELECT metadata->>'fetchMode' AS fetch_mode FROM ai_training_web_page WHERE website_id=$1`, [id])).rows[0].fetch_mode, 'http')
  } finally { await db.close() }
})

test('real Sitemap discovery applies robots, exclusions, same-origin and page limits', async () => {
  const fetcher = async (url: string) => ({ url, status: 200, headers: {}, body: url.endsWith('robots.txt')
    ? 'User-agent: *\nDisallow: /private\nSitemap: https://example.com/sitemap.xml'
    : '<urlset><url><loc>https://example.com/start</loc></url><url><loc>https://example.com/private</loc></url><url><loc>https://example.com/blog/1</loc></url><url><loc>https://evil.example.com/page</loc></url></urlset>' })
  const result = await discoverWebSourcePages(webSourceDiscovery.parse({ url: 'https://example.com/robots.txt', inputType: 'robots', excludes: '/blog' }), fetcher)
  assert.deepEqual(result.pages.map(p => p.url), ['https://example.com/start'])
  await assert.rejects(discoverWebSourcePages(webSourceDiscovery.parse({ url: 'https://example.com/robots.txt', inputType: 'robots' }), async url => ({ url, status: 404, headers: {}, body: '' })), /robots_has_no_sitemap/)
})

test('durable crawl/index lifecycle, failure retention, leases, tenant isolation and removal', async t => {
  const db = new PGlite({ extensions: { vector } })
  const pool = {
    query: async (sql: string, params?: unknown[]) => { const result = await db.query(sql, params); return { ...result, rowCount: result.affectedRows ?? result.rows.length } },
    connect: async () => ({ query: pool.query, release() {} }),
  } as unknown as Pool
  const org = 'web-source-' + randomUUID(), other = org + '-other'
  let version = 1, embedCalls = 0, prepareCalls = 0
  const prepare = async (page: { content: string }) => { prepareCalls++; return { content: page.content, summary: "Widget installation and notifications", keywords: ["widget", "configuration"], evidence: ["Install the widget and configure notifications."] } }
  const fetcher = async (url: string) => ({ url, status: 200, headers: { 'content-type': 'text/html', etag: 'v' + version }, body: url.endsWith('/robots.txt') ? 'User-agent: *\nAllow: /' : `<main><h1>Widget installation</h1><p>Install the widget and configure notifications. Version ${version}. Teams can collect feedback from customers.</p></main>` })
  const embed = async (inputs: string[]) => { embedCalls++; return inputs.map(() => [1, ...Array(767).fill(0)]) }
  const sourceInput = () => webSourceInput.parse({ url: 'https://example.com/sitemap.xml', inputType: 'sitemap', name: 'Documentation', frequency: 'weekly', pages: [{ title: 'Installation', url: 'https://example.com/install' }] })
  const run = (id: string) => webSourceTransaction(pool, client => startWebSourceRun(client, org, id, 'manual'))
  try {
    await db.exec(`CREATE EXTENSION vector;
      CREATE TABLE organization(id text PRIMARY KEY,metadata text);
      CREATE TABLE help_collection(id uuid PRIMARY KEY,org_id text,name text,position int,visible boolean DEFAULT true);
      CREATE TABLE scheduled_task(id uuid PRIMARY KEY,kind text NOT NULL,ref_id uuid,item_id text,schedule_at timestamptz NOT NULL,status text DEFAULT 'pending',attempts int DEFAULT 0,result text,manual_retry boolean DEFAULT false,updated_at timestamptz DEFAULT now());
      CREATE UNIQUE INDEX task_reference ON scheduled_task(kind,ref_id) WHERE item_id IS NULL;`)
    await db.exec(await readFile(new URL('../server/db/migrations/0020_help_vector_index.sql', import.meta.url), 'utf8'))
    await db.exec(await readFile(new URL('../server/db/migrations/0021_ai_training.sql', import.meta.url), 'utf8'))
    await pool.query('INSERT INTO organization(id) VALUES($1),($2)', [org, other])
    const { id } = await createWebSource(pool, org, sourceInput())
    const { rows: [page] } = await pool.query('SELECT id FROM ai_training_web_page WHERE website_id=$1', [id])
    await t.test('first sync produces a searchable, scoped index', async () => {
      await assert.rejects(run(id), /already running/)
      assert.equal((await runNextWebSourceTask(pool, { prepare, fetcher, embed })).ready, true)
      const document = await readWebSourcePage(pool, org, page.id, true)
      assert.ok(document.content.includes('Version 1'))
      assert.ok(document.indexedAt)
      assert.equal(document.title, 'Widget installation')
      assert.equal(document.description, 'Widget installation and notifications')
      assert.deepEqual(document.keywords, ['widget', 'configuration'])
      assert.equal('metadata' in document, false, 'read API keeps snapshot and processing details private')
      assert.equal((await searchWebPages(pool, org, 'widget', embed)).length, 1)
      assert.equal((await searchWebPages(pool, other, 'widget', embed)).length, 0)
      await assert.rejects(readWebSourcePage(pool, other, page.id, true), /Page not found/)
      await assert.rejects(updateWebSourceSettings(pool, other, id, { frequency: 'manual', paused: false, excludes: '' }), /Source not found/)
    })
    await t.test('unchanged content and 304 do not repeat indexing', async () => {
      const calls = embedCalls, preparations = prepareCalls
      await run(id); await runNextWebSourceTask(pool, { prepare, fetcher, embed })
      assert.equal(embedCalls, calls)
      await run(id)
      await runNextWebSourceTask(pool, { prepare, embed, fetcher: async (url, headers) => {
        if (url.endsWith('robots.txt')) return fetcher(url)
        assert.equal(headers?.['If-None-Match'], 'v1')
        return { url, status: 304, headers: {}, body: '' }
      } })
      assert.equal(embedCalls, calls)
      assert.equal(prepareCalls, preparations)
    })
    await t.test('automatic source tasks create a durable run and schedule the next update', async () => {
      await pool.query("UPDATE scheduled_task SET schedule_at=clock_timestamp()-interval '1 second' WHERE kind='ai_training_website' AND ref_id=$1", [id])
      await runNextWebSourceTask(pool, { prepare, fetcher, embed })
      const { rows: [next] } = await pool.query("SELECT status,schedule_at>clock_timestamp() AS future FROM scheduled_task WHERE kind='ai_training_website' AND ref_id=$1", [id])
      assert.equal(next.status, 'pending'); assert.equal(next.future, true)
      assert.equal((await runNextWebSourceTask(pool, { prepare, fetcher, embed })).ready, true)
      const { rows: [last] } = await pool.query('SELECT trigger,status FROM ai_training_website_run WHERE website_id=$1 ORDER BY started_at DESC LIMIT 1', [id])
      assert.equal(last.trigger, 'scheduled'); assert.equal(last.status, 'done')
    })
    await t.test('changed content switches atomically and indexed websites are searchable', async () => {
      version = 2; await run(id); await runNextWebSourceTask(pool, { prepare, fetcher, embed })
      assert.ok((await readWebSourcePage(pool, org, page.id, true)).content.includes('Version 2'))
      assert.ok((await searchWebPages(pool, org, 'widget', embed)).length > 0)
    })
    await t.test('processed content lives on the page without HTML snapshots', async () => {
      const { rows: [current] } = await pool.query('SELECT * FROM ai_training_web_page WHERE id=$1', [page.id])
      assert.equal('snapshotPrefix' in current.metadata, false)
      assert.ok(current.metadata.content.includes('Version 2'))
      assert.equal(current.metadata.title, 'Widget installation')
      assert.equal(current.metadata.etag, 'v2')
      assert.ok(current.metadata.contentHash)
      assert.ok(current.metadata.processorVersion)
      for (const key of ['title', 'content', 'content_hash', 'etag', 'last_modified', 'processor_version', 'fetch_mode']) assert.equal(key in current, false)
      assert.equal(current.metadata.summary, 'Widget installation and notifications')
      assert.deepEqual(current.metadata.keywords, ['widget', 'configuration'])
      assert.equal((await pool.query("SELECT 1 FROM information_schema.tables WHERE table_name IN ('web_material','web_chunk')")).rows.length, 0)
    })
    await t.test('AI preparation failure retains the published version and refetches on retry', async () => {
      version = 20; await run(id)
      const result = await runNextWebSourceTask(pool, { fetcher, embed, prepare: async () => { throw new CrawlError('cleanup_unavailable', true) } })
      assert.equal(result.retry, true)
      assert.ok((await readWebSourcePage(pool, org, page.id, true)).content.includes('Version 2'))
      const { rows: [raw] } = await pool.query("SELECT metadata FROM ai_training_web_page WHERE id=$1", [page.id])
      assert.equal('snapshotPrefix' in raw.metadata, false)
      assert.equal(raw.metadata.summary, 'Widget installation and notifications')
      assert.ok(raw.metadata.content.includes('Version 2'))
      assert.equal(raw.metadata.etag, 'v2', 'failed preparation retains validators for the published content')
      assert.deepEqual(raw.metadata.keywords, ['widget', 'configuration'])
      assert.equal(raw.metadata.error, 'cleanup_unavailable')
      await pool.query("UPDATE scheduled_task SET schedule_at=clock_timestamp() WHERE kind='web_page' AND ref_id=$1", [page.id])
      await runNextWebSourceTask(pool, { prepare, fetcher, embed })
      assert.ok((await readWebSourcePage(pool, org, page.id, true)).content.includes('Version 20'))
      version = 2; await run(id); await runNextWebSourceTask(pool, { prepare, fetcher, embed })
    })
    await t.test('processor upgrades rebuild unchanged pages without a separate material cache', async () => {
      const before = embedCalls, preparations = prepareCalls
      await pool.query("UPDATE ai_training_web_page SET metadata=metadata||jsonb_build_object('processorVersion','old') WHERE id=$1", [page.id])
      await run(id)
      await runNextWebSourceTask(pool, { prepare, embed, fetcher: async (url, headers) => {
        if (!url.endsWith('robots.txt')) assert.equal(headers?.['If-None-Match'], undefined)
        return fetcher(url)
      } })
      assert.equal(embedCalls, before + 1)
      assert.equal(prepareCalls, preparations + 1)
    })
    await t.test('terminal fetch errors preserve the last usable version', async () => {
      await run(id)
      await runNextWebSourceTask(pool, { prepare, embed, fetcher: async url => url.endsWith('robots.txt') ? fetcher(url) : { url, status: 403, headers: {}, body: '' } })
      const document = await readWebSourcePage(pool, org, page.id, true)
      assert.equal(document.error, 'http_403')
      assert.ok(document.content.includes('Version 2'))
      const { rows: [history] } = await pool.query('SELECT status,failed FROM ai_training_website_run WHERE id=(SELECT run_id FROM ai_training_web_page WHERE id=$1)', [page.id])
      assert.equal(history.status, 'failed'); assert.equal(history.failed, 1)
    })
    await t.test('transient failures retry durably and settle on exhaustion', async () => {
      await run(id)
      const fail = async () => { throw new CrawlError('fetch_timeout', true) }
      for (let attempt = 1; attempt <= 3; attempt++) {
        const result = await runNextWebSourceTask(pool, { prepare, embed, fetcher: fail })
        assert.equal(result.retry, attempt < 3)
        await pool.query("UPDATE scheduled_task SET schedule_at=clock_timestamp()-interval '1 second' WHERE kind='web_page' AND ref_id=$1", [page.id])
      }
      assert.equal((await readWebSourcePage(pool, org, page.id, true)).error, 'fetch_timeout')
    })
    await t.test('pause cancels future automatic tasks and permits manual sync', async () => {
      await updateWebSourceSettings(pool, org, id, { frequency: 'weekly', paused: true, excludes: '' })
      assert.equal((await pool.query("SELECT id FROM scheduled_task WHERE kind='ai_training_website' AND ref_id=$1", [id])).rows.length, 0)
      await run(id); await runNextWebSourceTask(pool, { prepare, fetcher, embed })
      assert.ok((await readWebSourcePage(pool, org, page.id, true)).indexedAt)
    })
    await t.test('a superseded worker cannot replace content', async () => {
      version = 3; await run(id)
      await runNextWebSourceTask(pool, { prepare, fetcher, embed: async inputs => {
        await pool.query("UPDATE scheduled_task SET id=$2,status='pending',attempts=0,schedule_at=clock_timestamp() WHERE kind='web_page' AND ref_id=$1", [page.id, randomUUID()])
        return embed(inputs)
      } })
      assert.ok((await readWebSourcePage(pool, org, page.id, true)).content.includes('Version 2'))
      await runNextWebSourceTask(pool, { prepare, fetcher, embed })
      assert.ok((await readWebSourcePage(pool, org, page.id, true)).content.includes('Version 3'))
    })
    await t.test('source removal during embedding cannot resurrect knowledge or tasks', async () => {
      version = 4; await run(id)
      await runNextWebSourceTask(pool, { prepare, fetcher, embed: async inputs => { await removeWebSource(pool, org, id); return embed(inputs) } })
      assert.equal((await pool.query('SELECT id FROM ai_training_web_page WHERE website_id=$1', [id])).rows.length, 0)
      assert.equal((await pool.query('SELECT content_id FROM content_chunk WHERE org_id=$1', [org])).rows.length, 0)
      assert.equal((await pool.query("SELECT id FROM scheduled_task WHERE kind IN ('web_page','ai_training_website')")).rows.length, 0)
    })
  } finally { await db.close() }
})


test('AI preparation removes only approved chrome and rejects invented evidence', () => {
  const content = '# Installation\n\nCopy code\n\nInstall the widget and configure notifications. Maximum 200 pages.\n\n```js\nCopy\nconst type = "<Widget>";\n```'
  const { candidates } = webSourceCleanupInput(content)
  assert.equal(candidates.length, 1)
  const output = { summary: 'Widget installation with a 200 page limit.', keywords: ['widget'], evidence: ['Install the widget and configure notifications.'], removeBlockIds: [candidates[0]!.id] }
  const result = parsePreparedWebSource(JSON.stringify(output), content)
  assert.ok(!result.content.includes('Copy code'))
  assert.ok(result.content.includes('Maximum 200 pages.'))
  assert.ok(result.content.includes('Copy\nconst type = "<Widget>";'))
  assert.throws(() => parsePreparedWebSource(JSON.stringify({ ...output, removeBlockIds: [4] }), content))
  assert.throws(() => parsePreparedWebSource(JSON.stringify({ ...output, evidence: ['An invented unlimited pages promise.'] }), content))
})


test('AI preparation retains valid evidence alongside short exact quotes', () => {
  const quote = 'Install the widget and configure notifications.'
  const content = '# Configuration\n\n' + quote + '\n\nMaximum 200 pages.'
  const output = { summary: 'Widget configuration.', keywords: ['widget'], evidence: [quote, '200 pages'], removeBlockIds: [] }
  assert.deepEqual(parsePreparedWebSource(JSON.stringify(output), content).evidence, [quote])
  assert.throws(() => parsePreparedWebSource(JSON.stringify({ ...output, evidence: ['200 pages'] }), content), /Insufficient supporting evidence/)
  assert.throws(() => parsePreparedWebSource(JSON.stringify({ ...output, evidence: [quote, 'invented'] }), content), /Ungrounded preparation/)
})

test('sync progress includes unchanged pages while the remaining pages are pending', async () => {
  const { db, pool, orgId } = await createWebSourceTestDatabase()
  try {
    await db.exec(`CREATE TABLE help_article(id uuid,org_id text,collection_id uuid,position int DEFAULT 0,title text,short_id text,slug text,ai_enabled boolean,published_at timestamptz,updated_at timestamptz,status text)`)
    const input = webSourceInput.parse({ url: 'https://example.com', inputType: 'website', frequency: 'manual', pages: [
      { title: 'Install', url: 'https://example.com/install' }, { title: 'Configure', url: 'https://example.com/configure' },
    ] })
    const { id } = await createWebSource(pool, orgId, input)
    const options = {
      fetcher: async (url: string) => ({ url, status: 200, headers: { 'content-type': url.endsWith('robots.txt') ? 'text/plain' : 'text/html' }, body: url.endsWith('robots.txt') ? '' : '<main><h1>Installation</h1><p>Install the widget and configure your workspace before publishing your website.</p></main>' }),
      prepare: async (page: { content: string }) => ({ content: page.content, summary: 'Widget installation.', keywords: ['widget'], evidence: ['Install the widget'] }),
      embed: async (values: string[]) => values.map(() => [1, ...Array(767).fill(0)]),
    }
    const due = () => pool.query("UPDATE scheduled_task SET schedule_at=clock_timestamp() WHERE kind='web_page' AND status='pending'")
    for (let i = 0; i < 2; i++) { await due(); assert.equal((await runNextWebSourceTask(pool, options)).ready, true) }
    await webSourceTransaction(pool, client => startWebSourceRun(client, orgId, id, 'manual'))
    let run = (await listAiTrainingWebsites(pool, orgId)).data.find(s => s.id === id)!.activeRun!
    assert.equal(run.processed, 0, 'previously indexed pages are not completed in the new run')
    await due(); assert.equal((await runNextWebSourceTask(pool, options)).ready, true)
    run = (await listAiTrainingWebsites(pool, orgId)).data.find(s => s.id === id)!.activeRun!
    assert.equal(run.status, 'running')
    assert.equal(run.added + run.updated + run.failed, 0)
    assert.equal(run.processed, 1, 'an unchanged page is still a completed page')
    assert.equal(run.total, 2)
  } finally { await db.close() }
})

test('indexed websites are available automatically, retained versions stay readable, deletion removes them', async () => {
  const { db, pool, orgId } = await createWebSourceTestDatabase()
  try {
    const input = webSourceInput.parse({ url: 'https://example.com', enabled: false, frequency: 'manual', pages: [
      { title: 'Ready', url: 'https://example.com/ready' }, { title: 'Pending', url: 'https://example.com/pending' }, { title: 'Retained', url: 'https://example.com/retained' },
    ] })
    assert.equal('enabled' in input, false, 'website creation has no AI visibility option')
    const { id } = await createWebSource(pool, orgId, input)
    const { rows } = await pool.query(`SELECT id,metadata->>'title' AS title FROM ai_training_web_page WHERE website_id=$1`, [id])
    const own = (title: string) => rows.find(r => r.title === title)!.id as string
    await pool.query("UPDATE ai_training_web_page SET indexed_at=clock_timestamp(),metadata=metadata||jsonb_build_object('content','Published content'),sync_status='ready' WHERE id=ANY($1::uuid[])", [[own('Ready'), own('Retained')]])
    await pool.query("UPDATE ai_training_web_page SET sync_status='failed',metadata=metadata||jsonb_build_object('error','http_500') WHERE id=$1", [own('Retained')])
    assert.equal((await readWebSourcePage(pool, orgId, own('Ready'), true)).content, 'Published content')
    assert.equal((await readWebSourcePage(pool, orgId, own('Retained'), true)).content, 'Published content')
    await assert.rejects(readWebSourcePage(pool, orgId, own('Pending'), true))
    await assert.rejects(readWebSourcePage(pool, orgId + '-other', own('Ready'), true))
    await pool.query("UPDATE ai_training_website_run SET status='done' WHERE website_id=$1", [id])
    await removeWebSourcePage(pool, orgId, own('Ready'))
    await assert.rejects(readWebSourcePage(pool, orgId, own('Ready'), true))
  } finally { await db.close() }
})

test('knowledge keeps disabled and internal help articles manageable without changing existing AI semantics', async () => {
  const { db, pool, orgId } = await createWebSourceTestDatabase()
  const previous = process.env.HELP_VECTOR_SEARCH
  process.env.HELP_VECTOR_SEARCH = 'true'
  const key = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = 'fixture'
  try {
    await db.exec(`CREATE TABLE help_article(id uuid,org_id text,collection_id uuid,position int DEFAULT 0,title text,short_id text,slug text,ai_enabled boolean,published_at timestamptz,updated_at timestamptz DEFAULT now(),status text)`)
    const first = randomUUID(), second = randomUUID(), foreignCollection = randomUUID()
    await pool.query(`INSERT INTO help_collection(id,org_id,name,position) VALUES($1,$3,'Getting started',0),($2,$3,'Account',1),($4,'another-org','Private',0)`, [first, second, orgId, foreignCollection])
    for (const [position, status] of ['published', 'draft', 'archived'].entries()) await pool.query('INSERT INTO help_article(id,org_id,collection_id,position,title,short_id,slug,ai_enabled,status) VALUES($1,$2,$4,$5,$3,$3,$3,false,$3)', [randomUUID(), orgId, status, position === 2 ? second : first, position])
    await pool.query(`INSERT INTO help_article(id,org_id,collection_id,title) VALUES($1,$2,$3,'Invalid cross-org collection')`, [randomUUID(), orgId, foreignCollection])
    await pool.query("UPDATE help_article SET published_at='2026-10-01T08:00:00Z' WHERE status='published'")
    const list = async () => { const result = await listManagementArticles({ db: drizzle(db), orgId } as Parameters<typeof listManagementArticles>[0], { page: 1, pageSize: 10 }); return result.data.map(a => ({ ...a, publicationStatus: a.status, collectionId: a.collection.id, collectionName: a.collection.name })) }
    const items = await list()
    assert.equal(new Date(items.find(item => item.publicationStatus === 'published')!.publishedAt).toISOString(), '2026-10-01T08:00:00.000Z')
    assert.equal(items.find(item => item.publicationStatus === 'draft')!.publishedAt, null)
    assert.equal(items.length, 3, 'AI-disabled articles remain manageable')
    assert.ok(items.every(item => item.aiEnabled === false), 'management retains each article AI setting')
    assert.deepEqual(items.map(item => [item.collectionId, item.collectionName]), [[first, 'Getting started'], [first, 'Getting started'], [second, 'Account']])
    assert.ok(items.every(item => item.indexStatus == null || item.indexStatus === 'not_indexed'))
    const published = items.find(item => item.publicationStatus === 'published')!, draft = items.find(item => item.publicationStatus === 'draft')!
    await pool.query(`INSERT INTO scheduled_task(id,kind,ref_id,status,result,schedule_at) VALUES($1,'help_index',$2,'done','indexed',clock_timestamp()),($3,'help_index',$4,'done','indexed',clock_timestamp())`, [randomUUID(), published.id, randomUUID(), draft.id])
    const indexed = await list()
    assert.equal(indexed.find(item => item.id === published.id)?.indexStatus, 'ready')
    assert.equal(indexed.find(item => item.id === draft.id)?.indexStatus, null, 'drafts do not expose a stale published index')
    await pool.query("UPDATE scheduled_task SET status='pending',result=NULL WHERE ref_id=$1 AND kind='help_index'", [published.id])
    assert.equal((await list()).find(item => item.id === published.id)?.indexStatus, 'indexing')
    await pool.query("UPDATE scheduled_task SET status='done',result='provider_500' WHERE ref_id=$1 AND kind='help_index'", [published.id])
    assert.equal((await list()).find(item => item.id === published.id)?.indexStatus, 'failed')
  } finally { if (previous === undefined) delete process.env.HELP_VECTOR_SEARCH; else process.env.HELP_VECTOR_SEARCH = previous; if (key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = key; await db.close() }
})

test('single-page sync preserves sibling state and schedule; deletion removes knowledge without re-adding it', async () => {
  const { db, pool, orgId } = await createWebSourceTestDatabase()
  try {
    const input = webSourceInput.parse({ url: 'https://example.com', inputType: 'website', frequency: 'weekly', pages: [
      { title: 'First', url: 'https://example.com/first' }, { title: 'Second', url: 'https://example.com/second' },
    ] })
    const { id } = await createWebSource(pool, orgId, input)
    let version = 1
    const options = {
      fetcher: async (url: string) => ({ url, status: 200, headers: { 'content-type': 'text/html' }, body: url.endsWith('robots.txt') ? '' : `<main><h1>Installation</h1><p>Install the widget and configure notifications. Version ${version}.</p></main>` }),
      prepare: async (page: { content: string }) => ({ content: page.content, summary: 'Installation.', keywords: ['widget'], evidence: ['Install the widget and configure notifications.'] }),
      embed: async (texts: string[]) => texts.map(() => [1, ...Array(767).fill(0)]),
    }
    for (let i = 0; i < 2; i++) {
      await pool.query("UPDATE scheduled_task SET schedule_at=clock_timestamp() WHERE kind='web_page' AND status='pending'")
      assert.equal((await runNextWebSourceTask(pool, options)).ready, true)
    }
    const { rows: pages } = await pool.query('SELECT id,run_id,url FROM ai_training_web_page WHERE website_id=$1 ORDER BY url', [id])
    const first = pages[0]!, second = pages[1]!
    const { rows: [before] } = await pool.query('SELECT next_run FROM ai_training_website WHERE id=$1', [id])
    await pool.query("UPDATE ai_training_web_page SET sync_status='failed',metadata=metadata||jsonb_build_object('error','http_500') WHERE id=$1", [second.id])
    version = 2
    const run = await syncWebSourcePage(pool, orgId, first.id)
    assert.equal((await pool.query('SELECT total FROM ai_training_website_run WHERE id=$1', [run.runId])).rows[0].total, 1)
    const sibling = (await pool.query(`SELECT run_id,metadata->>'error' AS error FROM ai_training_web_page WHERE id=$1`, [second.id])).rows[0]
    assert.equal(sibling.run_id, second.run_id)
    assert.equal(sibling.error, 'http_500')
    await assert.rejects(removeWebSourcePage(pool, orgId, first.id), /Wait for the current sync/)
    assert.equal((await runNextWebSourceTask(pool, options)).ready, true)
    assert.ok((await readWebSourcePage(pool, orgId, first.id)).content.includes('Version 2'))
    const { rows: [after] } = await pool.query('SELECT next_run FROM ai_training_website WHERE id=$1', [id])
    assert.equal(new Date(after.next_run).getTime(), new Date(before.next_run).getTime())
    assert.equal((await pool.query(`SELECT metadata->>'error' AS error FROM ai_training_web_page WHERE id=$1`, [second.id])).rows[0].error, 'http_500', 'single-page success does not hide a sibling failure')
    await assert.rejects(syncWebSourcePage(pool, orgId + '-other', first.id))
    await assert.rejects(removeWebSourcePage(pool, orgId + '-other', first.id))
    await removeWebSourcePage(pool, orgId, first.id)
    for (const [table, field] of [['ai_training_web_page', 'id'], ['content_chunk', 'content_id'], ['scheduled_task', 'ref_id']]) {
      assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE ${field}=$1`, [first.id])).rows.length, 0)
    }
    const next = await webSourceTransaction(pool, client => startWebSourceRun(client, orgId, id, 'manual'))
    assert.equal((await pool.query('SELECT total FROM ai_training_website_run WHERE id=$1', [next])).rows[0].total, 1)
    assert.equal((await pool.query('SELECT id FROM ai_training_web_page WHERE website_id=$1', [id])).rows.length, 1)
  } finally { await db.close() }
})

test('website badges and filters expose only indexed, indexing and failed, independently of retained AI content', () => {
  const item = { id: 'page', sourceId: 'source', title: 'Page', url: 'https://example.com', status: 'ready', enabled: true, updatedAt: '', content: '' } as const
  assert.equal(aiTrainingProcessingStatus(item), 'ready')
  for (const syncStatus of ['pending', 'processing'] as const) assert.equal(aiTrainingProcessingStatus({ ...item, syncStatus }), 'indexing')
  for (const errorCode of ['cleanup_invalid_response', 'http_403', 'provider_500']) {
    const failed = { ...item, syncStatus: 'failed' as const, errorCode }
    assert.equal(aiTrainingProcessingStatus(failed), 'failed')
    assert.equal(aiTrainingMatchesIndexFilter(failed, 'failed'), true)
    assert.equal(aiTrainingMatchesIndexFilter(failed, 'ready'), false)
    assert.equal(aiTrainingAiEligible(failed), true, 'retained index remains usable even when the latest update fails')
  }
  assert.equal(aiTrainingMatchesIndexFilter({ ...item, status: 'indexing', syncStatus: 'pending' }, 'indexing'), true)
  assert.equal(aiTrainingMatchesIndexFilter(item, 'ready'), true)
  assert.equal(aiTrainingMatchesIndexFilter(item, 'all'), true)
})

test('website and run results distinguish partial failure from all pages failing', () => {
  const pages = { total: 10, ready: 8, failed: 2, pending: 0, indexed: 10 }
  assert.equal(aiTrainingWebsiteStatus({ status: 'attention', pages }), 'partial')
  assert.equal(aiTrainingWebsiteStatus({ status: 'attention', pages: { ...pages, ready: 0, failed: 10 } }), 'failed', 'old usable indexes do not count as successful updates')
  assert.equal(aiTrainingWebsiteStatus({ status: 'syncing', pages }), 'indexing')
  assert.equal(aiTrainingWebsiteStatus({ status: 'ready', pages: { ...pages, ready: 10, failed: 0 } }), 'ready')
  assert.equal(aiTrainingWebsiteStatus({ status: 'attention', pages: { total: 10, failed: 2, pending: 0, indexed: 8 } }), 'partial')
  assert.equal(aiTrainingRunStatus({ status: 'failed', failed: 2, total: 10 }), 'partial')
  assert.equal(aiTrainingRunStatus({ status: 'failed', failed: 1, total: 1 }), 'failed', 'a failed single-page operation does not become a partial run')
  assert.equal(aiTrainingRunStatus({ status: 'running', failed: 1, total: 10 }), 'running')
})

test('help collection filter follows article publication independently of indexing and AI visibility', () => {
  const item = { id: 'article', sourceId: 'help', title: 'Article', url: '/help/article', status: 'ready', enabled: true, updatedAt: '', content: '', publicationStatus: 'draft', indexStatus: 'not_indexed' } as const
  assert.equal(aiTrainingMatchesHelpPublication(item, 'unpublished'), true)
  assert.equal(aiTrainingMatchesHelpPublication({ ...item, publicationStatus: 'archived' }, 'unpublished'), true)
  assert.equal(aiTrainingMatchesHelpPublication(item, 'published'), false)
  assert.equal(aiTrainingMatchesHelpPublication({ ...item, publicationStatus: 'published', indexStatus: 'failed', enabled: false }, 'published'), true)
  assert.equal(aiTrainingMatchesHelpPublication(item, 'all'), true)
  assert.equal(aiTrainingAiEligible(item), true)
})


test('bulk webpage operations isolate tenants, reject busy sources atomically and preserve siblings and schedules', async () => {
  const { db, pool, orgId } = await createWebSourceTestDatabase()
  try {
    const input = (host: string) => webSourceInput.parse({ url: `https://${host}`, inputType: 'website', frequency: 'weekly', pages: [
      { title: 'Selected', url: `https://${host}/selected` }, { title: 'Sibling', url: `https://${host}/sibling` },
    ] })
    await pool.query('INSERT INTO organization(id) VALUES($1)', [orgId + '-foreign'])
    const first = await createWebSource(pool, orgId, input('first.example.com'))
    const second = await createWebSource(pool, orgId, input('second.example.com'))
    const foreign = await createWebSource(pool, orgId + '-foreign', input('foreign.example.com'))
    await pool.query("UPDATE ai_training_website_run SET status='done',finished_at=clock_timestamp()")
    await pool.query("UPDATE ai_training_website SET next_run=clock_timestamp()+interval '7 days'")
    await pool.query("UPDATE ai_training_web_page SET sync_status='failed',metadata=metadata||jsonb_build_object('error','http_500')")
    const { rows: pages } = await pool.query(`SELECT id,website_id,metadata->>'title' AS title,run_id,metadata->>'error' AS error FROM ai_training_web_page ORDER BY website_id,id`)
    const selected = pages.filter(p => p.title === 'Selected' && p.website_id !== foreign.id)
    const siblings = pages.filter(p => p.title === 'Sibling' && p.website_id !== foreign.id)
    const schedules = (await pool.query('SELECT id,next_run FROM ai_training_website WHERE org_id=$1 ORDER BY id', [orgId])).rows
    const ids = selected.map(p => p.id)
    const result = await syncWebSourcePages(pool, orgId, [...ids, ids[0]])
    assert.equal(result.affected, 2)
    assert.equal(result.runs.length, 2)
    for (const run of result.runs) assert.equal((await pool.query('SELECT total FROM ai_training_website_run WHERE id=$1', [run.runId])).rows[0].total, 1)
    for (const sibling of siblings) {
      const current = (await pool.query(`SELECT run_id,metadata->>'error' AS error FROM ai_training_web_page WHERE id=$1`, [sibling.id])).rows[0]
      assert.deepEqual(current, { run_id: sibling.run_id, error: sibling.error })
    }
    assert.deepEqual((await pool.query('SELECT id,next_run FROM ai_training_website WHERE org_id=$1 ORDER BY id', [orgId])).rows, schedules)
    await pool.query("UPDATE ai_training_website_run SET status='done' WHERE website_id=$1", [first.id])
    const before = (await pool.query('SELECT count(*)::int AS count FROM ai_training_website_run')).rows[0].count
    await assert.rejects(syncWebSourcePages(pool, orgId, ids), /Wait for the current sync/)
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM ai_training_website_run')).rows[0].count, before)
    await assert.rejects(removeWebSourcePages(pool, orgId, ids), /Wait for the current sync/)
    assert.equal((await pool.query('SELECT id FROM ai_training_web_page WHERE id=ANY($1::uuid[])', [ids])).rows.length, 2)
    await pool.query("UPDATE ai_training_website_run SET status='done' WHERE website_id=$1", [second.id])
    const foreignId = pages.find(p => p.website_id === foreign.id)!.id
    await assert.rejects(removeWebSourcePages(pool, orgId, [ids[0], foreignId]), /Page not found/)
    await assert.rejects(syncWebSourcePages(pool, orgId, [ids[0], foreignId]), /Page not found/)
    assert.equal((await pool.query('SELECT id FROM ai_training_web_page WHERE id=$1', [ids[0]])).rows.length, 1)
    assert.deepEqual(await removeWebSourcePages(pool, orgId, ids), { affected: 2 })
    assert.equal((await pool.query("SELECT id FROM scheduled_task WHERE kind='web_page' AND ref_id=ANY($1::uuid[])", [ids])).rows.length, 0)
    assert.equal((await pool.query('SELECT id FROM ai_training_web_page WHERE org_id=$1', [orgId])).rows.length, 2)
    assert.equal((await pool.query('SELECT id FROM ai_training_web_page WHERE website_id=$1', [foreign.id])).rows.length, 2)
  } finally { await db.close() }
})


test('website update frequencies schedule weekly, biweekly and calendar-monthly tasks; never allows manual sync', async () => {
  const { db, pool, orgId } = await createWebSourceTestDatabase()
  try {
    const base = { url: 'https://example.com', inputType: 'website', pages: [{ title: 'Start', url: 'https://example.com/start' }] }
    assert.equal(webSourceInput.parse(base).frequency, 'weekly')
    assert.equal(webSourceInput.safeParse({ ...base, frequency: 'daily' }).success, false)
    const { id } = await createWebSource(pool, orgId, webSourceInput.parse(base))
    await pool.query("UPDATE ai_training_website_run SET status='done' WHERE website_id=$1", [id])
    await pool.query("UPDATE ai_training_website SET name='Docs',page_limit=42,updated_at='2000-01-01T00:00:00Z' WHERE id=$1", [id])
    for (const [frequency, interval] of [['weekly', '7 days'], ['biweekly', '14 days'], ['monthly', '1 month']] as const) {
      await updateWebSourceSettings(pool, orgId, id, webSourceSettings.parse({ frequency, paused: false }))
      const { rows: [source] } = await pool.query(`SELECT next_run BETWEEN clock_timestamp()+$2::interval-interval '5 seconds' AND clock_timestamp()+$2::interval+interval '5 seconds' AS correct FROM ai_training_website WHERE id=$1`, [id, interval])
      assert.equal(source.correct, true, frequency)
      assert.equal((await pool.query("SELECT id FROM scheduled_task WHERE kind='ai_training_website' AND ref_id=$1", [id])).rows.length, 1)
    }
    await updateWebSourceSettings(pool, orgId, id, webSourceSettings.parse({ frequency: 'weekly', paused: true, excludes: '/private' }))
    const { rows: [paused] } = await pool.query('SELECT * FROM ai_training_website WHERE id=$1', [id])
    assert.equal(paused.next_run, null)
    assert.equal(paused.paused, true)
    assert.equal(paused.name, 'Docs')
    assert.equal(paused.page_limit, 42)
    assert.equal(paused.excludes, '/private')
    assert.equal(Object.keys(paused).length, 13)
    assert.equal('metadata' in paused, false)
    assert.equal(paused.input_type, 'website')
    assert.ok(+new Date(paused.updated_at) > +new Date('2000-01-01T00:00:00Z'))
    for (const column of ['favicon_object_key', 'last_success']) assert.equal(column in paused, false)
    assert.equal((await pool.query("SELECT id FROM scheduled_task WHERE kind='ai_training_website' AND ref_id=$1", [id])).rows.length, 0)
    await assert.rejects(importIndividualWebSourcePages(pool, orgId, { urls: ['https://example.com/private/settings'], frequency: 'weekly' }), /excluded by source settings/)
    await updateWebSourceSettings(pool, orgId, id, webSourceSettings.parse({ frequency: 'manual', paused: false }))
    assert.equal((await pool.query('SELECT next_run FROM ai_training_website WHERE id=$1', [id])).rows[0].next_run, null)
    assert.equal((await pool.query("SELECT id FROM scheduled_task WHERE kind='ai_training_website' AND ref_id=$1", [id])).rows.length, 0)
    assert.ok(await webSourceTransaction(pool, client => startWebSourceRun(client, orgId, id, 'manual')))
  } finally { await db.close() }
})


test('automatic website entry discovers HTML, Sitemap and robots without a client-selected input type', async () => {
  const page = '<main><h1>Start</h1><p>Install the product widget and configure your workspace to get started.</p></main>'
  const map = '<urlset><url><loc>https://example.com/docs/start</loc></url></urlset>'
  const fetcher = async (url: string) => ({ url, status: 200, headers: { 'content-type': url.endsWith('.xml') || url.endsWith('/map') ? 'application/xml' : 'text/html' }, body: url.endsWith('robots.txt') ? 'User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml' : url.endsWith('.xml') || url.endsWith('/map') ? map : page })
  for (const [url, expected] of [['https://example.com', 'website'], ['https://example.com/sitemap.xml', 'sitemap'], ['https://example.com/robots.txt', 'robots'], ['https://example.com/map', 'sitemap']]) {
    const result = await discoverWebSourcePages(webSourceDiscovery.parse({ url }), fetcher)
    assert.equal(result.inputType, expected)
    assert.ok(result.pages.some(item => item.url === 'https://example.com/docs/start'))
  }
  assert.equal(webSourceInputTypeForUrl('https://example.com/sitemap.xml.gz?language=en'), 'sitemap')
  const result = await discoverWebSourcePages(webSourceDiscovery.parse({ url: 'https://example.com' }), async url => ({ url, status: 200, headers: {}, body: url.endsWith('robots.txt') ? '' : url.endsWith('sitemap.xml') ? map : page }))
  assert.ok(result.pages.some(item => item.url === 'https://example.com/docs/start'), 'discover conventional sitemap when robots does not list one')
})

test('inline page hierarchy caps management depth and retains complete import paths', () => {
  const pages = ['/', '/docs/start', '/docs/api/v2/auth', '/docs/api/v3/auth', '/docs-other/start', '/billing/plan'].map(path => ({ url: 'https://example.com' + path }))
  const nodes = webSourcePageTree(pages)
  const closed = flattenWebSourcePageTree(nodes, new Set())
  assert.equal(closed.filter(n => n.kind === 'page').length, 1)
  const docs = closed.find(n => n.key === '/docs/')!
  assert.equal(docs.pages.length, 3)
  assert.ok(docs.pages.every(p => new URL(p.url).pathname.startsWith('/docs/')))
  const expanded = flattenWebSourcePageTree(nodes, new Set(['/docs/', '/docs/api/']))
  assert.ok(expanded.every(n => n.depth <= 2))
  assert.ok(expanded.some(n => n.label === 'v2/auth' && n.depth === 2))
  assert.ok(expanded.some(n => n.label === 'v3/auth' && n.depth === 2))
  assert.equal(flattenWebSourcePageTree(nodes, new Set(), true).filter(n => n.kind === 'page').length, pages.length)
  const full = flattenWebSourcePageTree(webSourcePageTree(pages, Infinity), new Set(), true)
  assert.ok(full.some(n => n.kind === 'page' && n.depth === 3 && n.label === 'auth'))
})

test('individual URL import groups sites, skips duplicates, preserves settings and rolls back busy imports', async () => {
  const { db, pool, orgId } = await createWebSourceTestDatabase()
  try {
    const input = webSourceIndividualImport.parse({ urls: ['https://example.com/docs/a', 'https://example.com/docs/a?utm_source=test', 'https://other.example.com/faq'], frequency: 'biweekly' })
    const imported = await importIndividualWebSourcePages(pool, orgId, input)
    assert.equal(imported.sourceIds.length, 2)
    assert.equal(imported.added, 2); assert.equal(imported.skipped, 1)
    const { rows: sources } = await pool.query('SELECT * FROM ai_training_website WHERE org_id=$1', [orgId])
    assert.ok(sources.every(row => row.frequency === 'biweekly'))
    const { rows: tasks } = await pool.query("SELECT ref_id FROM scheduled_task WHERE kind='web_page'")
    assert.equal(tasks.length, 2, 'only explicit pages are scheduled')
    assert.equal((await importIndividualWebSourcePages(pool, orgId, input)).added, 0)
    await assert.rejects(importIndividualWebSourcePages(pool, orgId, { ...input, urls: ['https://new.example.com/page', 'https://example.com/docs/b'] }))
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM ai_training_website')).rows[0].n, 2, 'new source rolled back when a later source is busy')
    await pool.query("UPDATE ai_training_website_run SET status='done' WHERE status='running'")
    const added = await importIndividualWebSourcePages(pool, orgId, { ...input, urls: ['https://example.com/docs/b'], frequency: 'monthly' })
    assert.equal(added.added, 1); assert.equal(added.sourceIds.length, 1)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM ai_training_website')).rows[0].n, 2)
    assert.ok((await pool.query(`SELECT frequency FROM ai_training_website`)).rows.every(row => row.frequency === 'biweekly'), 'existing schedules are unchanged')
    const { rows: page } = await pool.query("SELECT id FROM ai_training_web_page WHERE url='https://example.com/docs/b'")
    await pool.query("UPDATE ai_training_website_run SET status='done' WHERE status='running'")
    await removeWebSourcePage(pool, orgId, page[0].id)
    assert.equal((await importIndividualWebSourcePages(pool, orgId, { ...input, urls: ['https://example.com/docs/b'] })).added, 1, 'explicit import can restore a deleted page')
    await assert.rejects(importIndividualWebSourcePages(pool, orgId, { ...input, urls: ['http://localhost/private'] }))
    const foreign = await importIndividualWebSourcePages(pool, orgId + '-other', input).catch(() => null)
    assert.equal(foreign, null, 'unknown organization cannot create a source')
  } finally { await db.close() }
})

test('page sync times track successful unchanged reads and source summary uses the latest page', async () => {
  const { db, pool, orgId } = await createWebSourceTestDatabase()
  try {
    await db.exec(`CREATE TABLE help_article(id uuid,org_id text,collection_id uuid,position int,title text,short_id text,slug text,ai_enabled boolean,published_at timestamptz,updated_at timestamptz,status text)`)
    const { id } = await createWebSource(pool, orgId, webSourceInput.parse({ url: 'https://example.com', frequency: 'manual', pages: [{ title: 'A', url: 'https://example.com/a' }, { title: 'B', url: 'https://example.com/b' }] }))
    const snapshot = async () => ({ sources: (await listAiTrainingWebsites(pool, orgId)).data, items: (await listAiTrainingWebsitePages(pool, orgId, id, { page: 1, pageSize: 10 })).data })
    assert.ok((await snapshot()).items.every(item => item.lastSyncedAt === null))
    const fetcher = async (url: string) => ({ url, status: 200, headers: { 'content-type': 'text/html', etag: 'v1' }, body: url.endsWith('robots.txt') ? '' : '<main><h1>Installation</h1><p>Install the widget and configure your workspace before publishing the website.</p></main>' })
    const options = { fetcher, prepare: async (page: { content: string }) => ({ content: page.content, summary: 'Widget installation', keywords: ['widget'], evidence: ['Install the widget and configure your workspace'] }), embed: async (texts: string[]) => texts.map(() => [1, ...Array(767).fill(0)]) }
    const due = () => pool.query("UPDATE scheduled_task SET schedule_at=clock_timestamp() WHERE kind='web_page' AND status='pending'")
    for (let i = 0; i < 2; i++) { await due(); assert.equal((await runNextWebSourceTask(pool, options)).ready, true) }
    const items = (await snapshot()).items
    const first = items.find(item => item.url.endsWith('/a'))!, sibling = items.find(item => item.url.endsWith('/b'))!
    await pool.query("UPDATE ai_training_web_page SET last_synced_at='2026-01-01' WHERE id=$1", [first.id])
    await pool.query("UPDATE ai_training_web_page SET last_synced_at='2026-02-01',sync_status='failed',metadata=metadata||jsonb_build_object('error','http_403') WHERE id=$1", [sibling.id])
    const indexedAt = (await readWebSourcePage(pool, orgId, first.id)).indexedAt
    await syncWebSourcePage(pool, orgId, first.id); await due()
    assert.equal((await runNextWebSourceTask(pool, { ...options, fetcher: async url => url.endsWith('robots.txt') ? fetcher(url) : { url, status: 304, headers: {}, body: '' } })).ready, true)
    const after = await snapshot(), syncedAt = after.items.find(item => item.id === first.id)!.lastSyncedAt
    assert.ok(new Date(syncedAt) > new Date('2026-02-01'))
    assert.equal(new Date(after.sources.find(source => source.id === id)!.lastSyncedAt).toISOString(), new Date(syncedAt).toISOString(), 'partial source failure does not hide latest successful page sync')
    assert.equal(new Date(after.items.find(item => item.id === sibling.id)!.lastSyncedAt).toISOString(), '2026-02-01T00:00:00.000Z')
    assert.equal(new Date((await readWebSourcePage(pool, orgId, first.id)).indexedAt).toISOString(), new Date(indexedAt).toISOString(), '304 does not rebuild the index')
    await syncWebSourcePage(pool, orgId, first.id); await due()
    await runNextWebSourceTask(pool, { ...options, fetcher: async url => url.endsWith('robots.txt') ? fetcher(url) : { url, status: 403, headers: {}, body: '' } })
    const failed = await snapshot()
    assert.equal(new Date(failed.items.find(item => item.id === first.id)!.lastSyncedAt).toISOString(), new Date(syncedAt).toISOString(), 'failed retry preserves last success')
  } finally { await db.close() }
})


test('logical relations validate parents and explicitly clean pages, sources and deleted organizations without crossing tenants', async () => {
  const { db, pool, orgId } = await createWebSourceTestDatabase()
  const foreignOrg = orgId + '-other'
  const input = (url: string, paths = ['/one', '/two']) => webSourceInput.parse({ url, pages: paths.map(path => ({ title: path, url: url + path })) })
  try {
    const foreignKeys = await pool.query("SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid WHERE c.contype='f' AND t.relname LIKE 'ai_training_%'")
    assert.equal(foreignKeys.rows.length, 0, 'website tables use logical associations in the initial migration')
    await assert.rejects(createWebSource(pool, 'missing-org', input('https://example.com')), /Organization not found/)
    await assert.rejects(importIndividualWebSourcePages(pool, 'missing-org', { urls: ['https://example.com/one'], frequency: 'weekly' }), /Organization not found/)
    assert.equal((await pool.query('SELECT id FROM ai_training_website')).rows.length, 0)
    await pool.query('INSERT INTO organization(id) VALUES($1)', [foreignOrg])
    const first = await createWebSource(pool, orgId, input('https://example.com'))
    const second = await createWebSource(pool, orgId, input('https://docs.example.com'))
    const foreign = await createWebSource(pool, foreignOrg, input('https://other.example.com', ['/one']))
    await assert.rejects(createWebSource(pool, orgId, input('https://example.com')), /already exists/)
    for (let i = 0; i < 5; i++) {
      await pool.query("UPDATE scheduled_task SET schedule_at=clock_timestamp() WHERE kind='web_page' AND status='pending'")
      assert.equal((await runNextWebSourceTask(pool, {
      fetcher: async url => ({ url, status: 200, headers: { 'content-type': 'text/html' }, body: url.endsWith('/robots.txt') ? '' : '<main><h1>Installation</h1><p>Install the widget and configure notifications to collect customer feedback.</p></main>' }),
      prepare: async page => ({ content: page.content, summary: 'Installation', keywords: ['widget'], evidence: ['Install the widget'] }),
      embed: async texts => texts.map(() => [1, ...Array(767).fill(0)]),
      })).ready, true)
    }
    const pages = (await pool.query('SELECT id,website_id FROM ai_training_web_page ORDER BY website_id,url')).rows
    const ownFirst = pages.filter(page => page.website_id === first.id), ownSecond = pages.filter(page => page.website_id === second.id), otherPage = pages.find(page => page.website_id === foreign.id)!
    const assertGone = async (ids: string[]) => {
      assert.equal((await pool.query('SELECT id FROM ai_training_web_page WHERE id=ANY($1::uuid[])', [ids])).rows.length, 0)
      assert.equal((await pool.query("SELECT content_id FROM content_chunk WHERE content_type='web_page' AND content_id=ANY($1::uuid[])", [ids])).rows.length, 0)
      assert.equal((await pool.query("SELECT id FROM scheduled_task WHERE kind='web_page' AND ref_id=ANY($1::uuid[])", [ids])).rows.length, 0)
    }
    await removeWebSourcePage(pool, orgId, ownFirst[0].id)
    await assertGone([ownFirst[0].id])
    assert.ok((await readWebSourcePage(pool, orgId, ownFirst[1].id)).content)
    await assert.rejects(removeWebSourcePages(pool, orgId, [ownFirst[1].id, otherPage.id]), /Page not found/)
    await removeWebSourcePages(pool, orgId, [ownFirst[1].id, ownSecond[0].id])
    await assertGone([ownFirst[1].id, ownSecond[0].id])
    await removeWebSource(pool, orgId, first.id)
    assert.equal((await pool.query('SELECT id FROM ai_training_website_run WHERE website_id=$1', [first.id])).rows.length, 0)
    assert.equal((await pool.query("SELECT id FROM scheduled_task WHERE kind='ai_training_website' AND ref_id=$1", [first.id])).rows.length, 0)
    await pool.query('DELETE FROM organization WHERE id=$1', [orgId])
    assert.equal((await pool.query('SELECT id FROM ai_training_website WHERE org_id=$1', [orgId])).rows.length, 1, 'SQL deletion does not cascade')
    await removeWebSourceOrganization(pool, orgId)
    await assertGone([ownSecond[1].id])
    assert.equal((await pool.query('SELECT id FROM ai_training_website WHERE org_id=$1', [orgId])).rows.length, 0)
    assert.equal((await pool.query('SELECT id FROM ai_training_website_run WHERE website_id=ANY($1::uuid[])', [[first.id, second.id]])).rows.length, 0)
    assert.ok((await readWebSourcePage(pool, foreignOrg, otherPage.id, true)).content)
    assert.equal('snapshotPrefix' in (await pool.query('SELECT metadata FROM ai_training_web_page WHERE org_id=$1', [foreignOrg])).rows[0].metadata, false)
    await removeWebSourceOrganization(pool, orgId) // Cleanup is safe to repeat.
  } finally { await db.close() }
})

test('sitemap keeps hreflang translations as distinct selectable pages', () => {
  const sitemap = `<urlset xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <url><loc>https://example.com/docs</loc><xhtml:link rel="alternate" hreflang="x-default" href="https://example.com/docs"/><xhtml:link rel="alternate" hreflang="ja" href="https://example.com/ja/docs"/></url>
  <url><loc>https://example.com/ja/docs</loc><xhtml:link rel="alternate" hreflang="x-default" href="https://example.com/docs"/><xhtml:link rel="alternate" hreflang="ja" href="https://example.com/ja/docs"/></url>
  </urlset>`
  assert.deepEqual(parseWebSourceSitemap(sitemap).urls, ['https://example.com/docs', 'https://example.com/ja/docs'])
  assert.equal(normalizeWebSourceUrl('https://example.com/docs/'), 'https://example.com/docs/', 'a meaningful trailing slash must survive redirects')
})

test('rule extraction keeps documentation beside a short interactive main landmark', () => {
  const html = '<html lang="en-US"><body><nav><h2>Navigation</h2>Do not keep navigation</nav><main><h1>Product</h1><p>Paste content here to start the interactive product.</p></main><section><h2>Install</h2><p>'+ 'Install the product using the documented steps. '.repeat(8)+'</p><h2>Limits</h2><p>The maximum file size is 20 MB.</p><pre><code>npm install example</code></pre></section></body></html>'
  const parsed = extractWebSourceContent(html, 'https://example.com')
  assert.ok(parsed.content.includes('20 MB'))
  assert.ok(parsed.content.includes('npm install example'))
  assert.equal(parsed.content.includes('Do not keep navigation'), false)
  assert.equal(parsed.language, 'en-US')
})
