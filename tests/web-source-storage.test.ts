import { webSourceTestStorage } from './fixtures/web-source-storage'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWebSourceTestDatabase } from './fixtures/web-source-database'
import { webSourceInput } from '../shared/schemas/web-source'
import { createWebSource, removeWebSource, syncWebSourcePage } from '../server/services/web-source'
import { runNextWebSourceTask } from '../server/lib/web-source/worker'
import { CrawlError } from '../server/lib/web-source/fetch'

test('website indexing, retries and removal do not require object storage or retain HTML', async () => {
  const { db, pool, orgId } = await createWebSourceTestDatabase()
  const put = webSourceTestStorage.put, del = webSourceTestStorage.del
  let storageCalls = 0, fetches = 0, version = 1, failPreparation = false
  webSourceTestStorage.put = async () => { storageCalls++; throw new Error('storage unavailable') }
  webSourceTestStorage.del = async () => { storageCalls++; throw new Error('storage unavailable') }
  const options = {
    fetcher: async (url: string) => {
      const robots = url.endsWith('/robots.txt')
      if (!robots) fetches++
      return { url, status: 200, headers: { 'content-type': 'text/html' }, body: robots ? '' : `<main><h1>Installation</h1><p>Install the widget and configure notifications. Version ${version}.</p></main>` }
    },
    prepare: async (page: { content: string }) => {
      if (failPreparation) throw new CrawlError('cleanup_unavailable', true)
      return { content: page.content, summary: 'Installation', keywords: ['widget'], evidence: ['Install the widget'] }
    },
    embed: async (input: string[]) => input.map(() => [1, ...Array(767).fill(0)]),
  }
  try {
    const { id } = await createWebSource(pool, orgId, webSourceInput.parse({ url: 'https://example.com', frequency: 'manual', pages: [{ title: '', url: 'https://example.com/guide' }] }))
    assert.equal((await runNextWebSourceTask(pool, options)).ready, true)
    const { rows: [page] } = await pool.query('SELECT * FROM ai_training_web_page WHERE website_id=$1', [id])
    assert.ok(page.metadata.content.includes('Version 1'))
    for (const key of ['snapshotPrefix', 'rawHtml', 'renderedHtml', 'raw_html_gzip', 'rendered_html_gzip']) {
      assert.equal(key in page, false)
      assert.equal(key in page.metadata, false)
    }
    assert.equal(fetches, 1)

    version = 2; failPreparation = true
    await syncWebSourcePage(pool, orgId, page.id)
    assert.equal((await runNextWebSourceTask(pool, options)).retry, true)
    assert.equal(fetches, 2)
    const failed = (await pool.query('SELECT metadata FROM ai_training_web_page WHERE id=$1', [page.id])).rows[0].metadata
    assert.ok(failed.content.includes('Version 1'))
    assert.equal('snapshotPrefix' in failed, false)

    version = 3; failPreparation = false
    await pool.query("UPDATE scheduled_task SET schedule_at=clock_timestamp() WHERE kind='web_page' AND ref_id=$1", [page.id])
    assert.equal((await runNextWebSourceTask(pool, options)).ready, true)
    assert.equal(fetches, 3)
    assert.ok((await pool.query('SELECT metadata FROM ai_training_web_page WHERE id=$1', [page.id])).rows[0].metadata.content.includes('Version 3'))
    await removeWebSource(pool, orgId, id)
    assert.equal((await pool.query('SELECT id FROM ai_training_web_page WHERE website_id=$1', [id])).rows.length, 0)
    assert.equal(storageCalls, 0)
  } finally {
    webSourceTestStorage.put = put; webSourceTestStorage.del = del
    await db.close()
  }
})
