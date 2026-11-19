import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startFixtures, origin } from './fixtures/web-source-http.mjs'
import { fetchWebSourceUrl } from '../server/lib/web-source/fetch'

test('HTTP fetch closes oversized, disconnected and cancelled responses', { timeout: 10000 }, async t => {
  const fixture = await startFixtures()
  try {
    await t.test('streaming body is rejected before downloading the complete fixture', async () => {
      await assert.rejects(fetchWebSourceUrl(origin + '/big'), /page_too_large/)
      assert.ok(fixture.sent.get('/big')! < 6 * 1024 * 1024)
    })
    await t.test('compressed expansion has the same body limit', async () => {
      await assert.rejects(fetchWebSourceUrl(origin + '/compressed-big'), /page_too_large/)
    })
    await t.test('remote disconnect settles the request', async () => {
      await assert.rejects(fetchWebSourceUrl(origin + '/aborted'), /fetch_failed/)
    })
    await t.test('abort cancels an incomplete response', async () => {
      await assert.rejects(fetchWebSourceUrl(origin + '/never', {}, undefined, { signal: AbortSignal.timeout(50) }), /fetch_failed/)
    })
    await t.test('subsequent requests still complete', async () => {
      const response = await fetchWebSourceUrl(origin + '/ssr')
      assert.equal(response.status, 200)
      assert.ok(response.body.includes('FINAL_EVIDENCE_42'))
    })
  } finally { await fixture.close() }
})
