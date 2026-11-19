import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createWebSourceTestDatabase } from './fixtures/web-source-database'
import { createWebSource, readWebSourcePage } from '../server/services/web-source'
import { webSourceInput } from '../shared/schemas/web-source'
import { startWebSourceRun, webSourceTransaction } from '../server/lib/web-source/jobs'
import { runNextWebSourceTask } from '../server/lib/web-source/worker'
import type { CrawlResponse } from '../server/lib/web-source/fetch'

test('incremental sync requires the complete published chunk generation', async t => {
  const { db, pool, orgId } = await createWebSourceTestDatabase()
  let preparations = 0, embeddings = 0
  const fetcher = async (url: string): Promise<CrawlResponse> => ({
    url, status: 200, headers: { 'content-type': 'text/html', etag: 'v1', 'last-modified': 'Fri, 13 Nov 2026 08:00:00 GMT' },
    body: url.endsWith('/robots.txt') ? '' : '<main><h1>Widget guide</h1><h2>Install</h2><p>Install the widget to collect product feedback and configure notifications for the team.</p><h2>Configure</h2><p>Configure notifications in the dashboard settings and share the widget with your team.</p></main>',
  })
  const options = {
    fetcher,
    prepare: async (page: { content: string }) => {
      preparations++
      return { content: page.content, summary: 'Widget installation and configuration.', keywords: ['widget'], evidence: ['Install the widget'] }
    },
    embed: async (inputs: string[]) => { embeddings++; return inputs.map(() => [1, ...Array(767).fill(0)]) },
  }
  try {
    const { id: sourceId } = await createWebSource(pool, orgId, webSourceInput.parse({ url: 'https://example.com', frequency: 'manual', pages: [{ title: '', url: 'https://example.com/guide' }] }))
    assert.equal((await runNextWebSourceTask(pool, options)).ready, true)
    const { rows: [page] } = await pool.query('SELECT id,metadata FROM ai_training_web_page WHERE website_id=$1', [sourceId])
    const expected = page.metadata.chunkCount
    assert.ok(expected >= 2)
    const run = () => webSourceTransaction(pool, client => startWebSourceRun(client, orgId, sourceId, 'manual'))
    const corruptions: [string, () => Promise<unknown>][] = [
      ['missing tail chunk', () => pool.query("DELETE FROM content_chunk WHERE content_type='web_page' AND content_id=$1 AND ordinal=$2", [page.id, expected - 1])],
      ['missing all chunks', () => pool.query("DELETE FROM content_chunk WHERE content_type='web_page' AND content_id=$1", [page.id])],
      ['noncontiguous ordinals with unchanged count', () => pool.query("UPDATE content_chunk SET ordinal=$2 WHERE content_type='web_page' AND content_id=$1 AND ordinal=1", [page.id, expected + 10])],
      ['mixed embedding models', () => pool.query("UPDATE content_chunk SET model='old-model' WHERE content_type='web_page' AND content_id=$1 AND ordinal=1", [page.id])],
      ['mixed index versions', () => pool.query("UPDATE content_chunk SET index_version='old-version' WHERE content_type='web_page' AND content_id=$1 AND ordinal=1", [page.id])],
      ['mixed generations', () => pool.query("UPDATE content_chunk SET generation_id=$2 WHERE content_type='web_page' AND content_id=$1 AND ordinal=1", [page.id, randomUUID()])],
      ['uniform but unpublished generation', () => pool.query("UPDATE content_chunk SET generation_id=$2 WHERE content_type='web_page' AND content_id=$1", [page.id, randomUUID()])],
      ['extra chunk', () => pool.query(`INSERT INTO content_chunk(content_type,content_id,ordinal,org_id,generation_id,heading,body,model,index_version,embedding)
        SELECT content_type,content_id,$2,org_id,generation_id,heading,body,model,index_version,embedding
        FROM content_chunk WHERE content_type='web_page' AND content_id=$1 AND ordinal=0`, [page.id, expected])],
      ['older page without integrity metadata', () => pool.query("UPDATE ai_training_web_page SET metadata=metadata-'chunkCount'-'indexGeneration' WHERE id=$1", [page.id])],
    ]
    for (const [name, corrupt] of corruptions) await t.test(name + ' forces a full rebuild', async () => {
      await corrupt()
      const before = { preparations, embeddings }
      await run()
      assert.equal((await runNextWebSourceTask(pool, { ...options, fetcher: async (url, headers) => {
        if (!url.endsWith('/robots.txt')) {
          assert.equal(headers?.['If-None-Match'], undefined)
          assert.equal(headers?.['If-Modified-Since'], undefined)
        }
        return fetcher(url)
      } })).ready, true)
      assert.equal(preparations, before.preparations + 1)
      assert.equal(embeddings, before.embeddings + 1)
      const { rows: [current] } = await pool.query('SELECT metadata FROM ai_training_web_page WHERE id=$1', [page.id])
      const { rows } = await pool.query("SELECT ordinal,generation_id FROM content_chunk WHERE content_type='web_page' AND content_id=$1 ORDER BY ordinal", [page.id])
      assert.equal(current.metadata.chunkCount, expected)
      assert.deepEqual(rows.map(row => row.ordinal), Array.from({ length: expected }, (_, i) => i))
      assert.ok(rows.every(row => row.generation_id === current.metadata.indexGeneration))
      assert.equal('indexGeneration' in await readWebSourcePage(pool, orgId, page.id), false)
    })
    await t.test('a complete generation accepts 304 without changing publication or fetch mode', async () => {
      const before = { preparations, embeddings }
      const { rows: [published] } = await pool.query('SELECT indexed_at,metadata FROM ai_training_web_page WHERE id=$1', [page.id])
      await run()
      assert.equal((await runNextWebSourceTask(pool, { ...options, fetcher: async (url, headers) => {
        if (url.endsWith('/robots.txt')) return fetcher(url)
        assert.equal(headers?.['If-None-Match'], 'v1')
        assert.equal(headers?.['If-Modified-Since'], 'Fri, 13 Nov 2026 08:00:00 GMT')
        return { url, status: 304, headers: {}, body: '' }
      } })).ready, true)
      assert.deepEqual({ preparations, embeddings }, before)
      const { rows: [current] } = await pool.query('SELECT indexed_at,metadata FROM ai_training_web_page WHERE id=$1', [page.id])
      assert.deepEqual(current.indexed_at, published.indexed_at)
      assert.equal(current.metadata.indexGeneration, published.metadata.indexGeneration)
      assert.equal(current.metadata.fetchMode, published.metadata.fetchMode)
    })
    await t.test('an unsolicited 304 cannot mark an incomplete generation as synchronized', async () => {
      await pool.query("DELETE FROM content_chunk WHERE content_type='web_page' AND content_id=$1 AND ordinal=1", [page.id])
      await run()
      const result = await runNextWebSourceTask(pool, { ...options, fetcher: async url => url.endsWith('/robots.txt') ? fetcher(url) : { url, status: 304, headers: {}, body: '' } })
      assert.equal(result.retry, true)
      assert.equal(result.code, 'invalid_not_modified')
      assert.ok((await readWebSourcePage(pool, orgId, page.id)).content.includes('Install the widget'))
    })
  } finally { await db.close() }
})

test('external page data refreshes behind unchanged HTML and failures preserve the published index', async () => {
  const { db, pool, orgId } = await createWebSourceTestDatabase()
  const { appendWebsiteData } = await import('../server/lib/web-source/page-data')
  let version = 1, preparations = 0, status = 200, unexpected304 = false
  const fetcher: NonNullable<Parameters<typeof runNextWebSourceTask>[1]>['fetcher'] = async (url, headers) => {
    if (url.endsWith('/robots.txt')) return { url, status: 200, headers: {}, body: '' }
    if (url.endsWith('/state.js')) return { url, status, headers: {}, body: `window.__NUXT__={article:{text:"Your plan allows ${version} public projects per workspace."}}` }
    assert.equal(headers?.['If-None-Match'], undefined, 'an HTML ETag cannot validate external data')
    return { url, status: unexpected304 ? 304 : 200, headers: { 'content-type': 'text/html', etag: 'same-html' },
      body: '<main><h1>Workspace plans</h1><p>Choose the appropriate plan for your public projects and collaboration requirements.</p></main><script src="/_nuxt/static/build/state.js"></script>' }
  }
  const options = { fetcher,
    prepare: async (page: Parameters<typeof import('../server/lib/web-source/prepare').prepareWebSourceContent>[0]) => {
      preparations++
      return { content: appendWebsiteData(page.content, page.data!.candidates), summary: 'Workspace plan limits.', keywords: ['plans'], evidence: [] }
    },
    embed: async (inputs: string[]) => inputs.map(() => [1, ...Array(767).fill(0)]),
  }
  try {
    const { id: sourceId } = await createWebSource(pool, orgId, webSourceInput.parse({ url: 'https://example.com', frequency: 'manual', pages: [{ title: '', url: 'https://example.com/guide' }] }))
    const run = () => webSourceTransaction(pool, client => startWebSourceRun(client, orgId, sourceId, 'manual'))
    assert.equal((await runNextWebSourceTask(pool, options)).ready, true)
    const { rows: [first] } = await pool.query('SELECT id,metadata,indexed_at FROM ai_training_web_page WHERE website_id=$1', [sourceId])
    assert.equal(first.metadata.externalData, true)
    assert.ok(first.metadata.content.includes('1 public projects'))
    await run()
    assert.equal((await runNextWebSourceTask(pool, options)).ready, true)
    assert.equal(preparations, 1, 'unchanged data avoids model and embedding work')
    version = 2
    await run()
    assert.equal((await runNextWebSourceTask(pool, options)).ready, true)
    assert.equal(preparations, 2)
    const { rows: [published] } = await pool.query('SELECT metadata,indexed_at FROM ai_training_web_page WHERE id=$1', [first.id])
    assert.ok(published.metadata.content.includes('2 public projects'))
    assert.notEqual(published.metadata.contentHash, first.metadata.contentHash)
    unexpected304 = true
    await run()
    const invalid = await runNextWebSourceTask(pool, options)
    assert.equal(invalid.code, 'invalid_not_modified')
    assert.equal(invalid.retry, true)
    unexpected304 = false; status = 503
    await pool.query("UPDATE scheduled_task SET schedule_at=clock_timestamp()-interval '1 second' WHERE ref_id=$1 AND kind='web_page'", [first.id])
    const failed = await runNextWebSourceTask(pool, options)
    assert.equal(failed.code, 'page_data_http_503')
    const { rows: [current] } = await pool.query('SELECT metadata,indexed_at FROM ai_training_web_page WHERE id=$1', [first.id])
    assert.equal(preparations, 2)
    assert.equal(current.metadata.indexGeneration, published.metadata.indexGeneration)
    assert.equal(current.metadata.content, published.metadata.content)
    assert.deepEqual(current.indexed_at, published.indexed_at)
  } finally { await db.close() }
})
