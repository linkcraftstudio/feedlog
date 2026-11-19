import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createError } from 'h3'
import { webSourceFailureCode, webSourceFailureStage } from '../shared/utils/web-source-failure'
import { publicWebSourceError, logWebSourceFailure } from '../server/lib/web-source/failure'
import { CrawlError } from '../server/lib/web-source/fetch'
import { createWebSourceTestDatabase } from './fixtures/web-source-database'
import { createWebSource } from '../server/services/web-source'
import { listAiTrainingWebsites, listAiTrainingWebsitePages } from '../server/services/ai-training'
import { webSourceInput } from '../shared/schemas/web-source'
import { runNextWebSourceTask } from '../server/lib/web-source/worker'

test('customer messages group website failures and internal failures without exposing detailed codes', () => {
  for (const code of ['http_404', 'http_403', 'dns_failed', 'fetch_timeout', 'page_noindex', 'page_login', 'page_challenge', 'page_requires_rendering', 'page_data_invalid_json', 'page_data_http_503']) {
    assert.equal(webSourceFailureCode(code), 'website_unavailable', code)
    const error = publicWebSourceError(new CrawlError(code))
    assert.deepEqual(error.data, { code: 'website_unavailable' })
    assert.ok(!error.message.includes(code))
  }
  for (const code of ['page_too_large', 'content_too_large', 'page_data_too_large', 'article_too_large', 'too_many_chunks']) assert.equal(webSourceFailureCode(code), 'content_limit')
  for (const code of ['cleanup_provider_401', 'cleanup_invalid_response', 'provider_429', 'not_configured', 'sync_unavailable', 'unknown_internal_error']) assert.equal(webSourceFailureCode(code), 'service_unavailable')
  assert.equal(webSourceFailureCode('robots_disallowed'), 'robots_disallowed')
  assert.equal(webSourceFailureStage('provider_429'), 'index')
  assert.equal(webSourceFailureStage('service_unavailable', 'fetch'), 'fetch', 'the actual stage survives public error grouping')
  assert.equal(webSourceFailureStage('http_404'), 'fetch')
  const conflict = createError({ statusCode: 409, message: 'Wait for the current sync', data: { code: 'sync_in_progress' } })
  assert.equal(publicWebSourceError(conflict), conflict)
  assert.deepEqual(publicWebSourceError(new Error('private database failure')).data, { code: 'service_unavailable' })
  assert.ok(!publicWebSourceError(new Error('private database failure')).message.includes('database'))
})

test('internal diagnostics retain failure details with URL and credential redaction', t => {
  const logs: unknown[][] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => { logs.push(args) })
  logWebSourceFailure(new Error('Failed https://user:secret@example.com/path Bearer fake-token sk-fake-secret'), { taskId: 'test-task', refId: 'test-page', stage: 'index' })
  const value = JSON.stringify(logs)
  assert.ok(value.includes('test-task') && value.includes('test-page') && value.includes('Failed'))
  for (const secret of ['user:secret', 'fake-token', 'sk-fake-secret']) assert.ok(!value.includes(secret))
})

test('failure counts distinguish fetch and index, robots are blocked before page fetch, and public codes stay grouped', async t => {
  t.mock.method(console, 'warn', () => {})
  const { db, pool, orgId } = await createWebSourceTestDatabase()
  const paths = ['/missing', '/blocked', '/model', '/large', '/good']
  const requested: string[] = []
  try {
    const { id } = await createWebSource(pool, orgId, webSourceInput.parse({ url: 'https://example.com', frequency: 'manual', pages: paths.map(path => ({ title: path, url: 'https://example.com' + path })) }))
    for (let i = 0; i < paths.length; i++) await runNextWebSourceTask(pool, {
      fetcher: async url => {
        requested.push(url)
        if (url.endsWith('/large')) throw new CrawlError('page_too_large')
        return { url, status: url.endsWith('/missing') ? 404 : 200, headers: { 'content-type': 'text/html', 'x-robots-tag': 'noindex' }, body: url.endsWith('/robots.txt') ? 'User-agent: *\nDisallow: /blocked' : '<meta name="robots" content="noindex"><main><h1>Public guide</h1><p>Install the widget and configure notifications to collect customer questions.</p></main>' }
      },
      prepare: async page => {
        if ((page as { url?: string }).url?.endsWith('/model')) throw new CrawlError('cleanup_provider_401')
        return { content: page.content, summary: 'Public guide.', keywords: ['widget'], evidence: ['configure notifications'] }
      },
      embed: async inputs => inputs.map(() => [1, ...Array(767).fill(0)]),
    })
    assert.ok(!requested.some(url => url.endsWith('/blocked')))
    const source = (await listAiTrainingWebsites(pool, orgId)).data[0]!
    assert.equal(source.pages.failed, 4)
    assert.equal(source.pages.ready, 1)
    assert.equal(source.pages.fetchFailed, 3)
    assert.equal(source.pages.indexFailed, 1)
    const pages = await listAiTrainingWebsitePages(pool, orgId, id, { page: 1, pageSize: 100, status: 'failed' })
    const byPath = new Map(pages.data.map(row => [new URL(row.url).pathname, row]))
    assert.equal(byPath.get('/missing')?.errorCode, 'website_unavailable')
    assert.equal(byPath.get('/blocked')?.errorCode, 'robots_disallowed')
    assert.equal(byPath.get('/model')?.errorCode, 'service_unavailable')
    assert.equal(byPath.get('/model')?.errorStage, 'index')
    assert.equal(byPath.get('/large')?.errorCode, 'content_limit')
    const raw = (await pool.query("SELECT metadata FROM ai_training_web_page WHERE website_id=$1 AND url LIKE '%/model'", [id])).rows[0].metadata
    assert.equal(raw.error, 'cleanup_provider_401')
    assert.equal(raw.errorStage, 'index')
    await pool.query("UPDATE ai_training_web_page SET metadata=metadata-'errorStage' WHERE website_id=$1", [id])
    const legacy = (await listAiTrainingWebsites(pool, orgId)).data[0]!
    assert.equal(legacy.pages.fetchFailed, 3)
    assert.equal(legacy.pages.indexFailed, 1)
    const legacyPages = await listAiTrainingWebsitePages(pool, orgId, id, { page: 1, pageSize: 100, status: 'failed' })
    assert.equal(legacyPages.data.find(page => page.url.endsWith('/model'))?.errorStage, 'index')
  } finally { await db.close() }
})
