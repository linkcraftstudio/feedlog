import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseEnglishHelpQueries, rewriteHelpQuery } from '../server/lib/help-search/rewrite'

test('accepts bounded English output and preserves code identifiers', () => {
  assert.deepEqual(parseEnglishHelpQueries('{"queries":["cancel   subscription"]}', '取消订阅'), ['cancel subscription'])
  assert.throws(() => parseEnglishHelpQueries('{"queries":["change secret"]}', '修改 BETTER_AUTH_SECRET'))
  assert.throws(() => parseEnglishHelpQueries('{"queries":["取消订阅"]}', '取消订阅'))
  assert.throws(() => parseEnglishHelpQueries('{"queries":[42]}', '取消订阅'))
})

test('English input bypasses model requests', async () => {
  assert.deepEqual(await rewriteHelpQuery('test-org', 'cancel subscription'), { mode: 'lexical' })
})

test('deduplicates concurrent rewrites, caches successful output and falls back on errors', async () => {
  const before = { ...process.env }
  const fetchBefore = globalThis.fetch
  let requests = 0
  Object.assign(process.env, { HELP_SEARCH_BILINGUAL: 'true', OPENAI_API_KEY: 'test', OPENAI_TEXT_MODEL: 'test', OPENAI_BASE_URL: 'https://example.invalid/v1' })
  globalThis.fetch = async () => {
    requests++
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"queries":["cancel subscription"]}' } }] }), { headers: { 'content-type': 'application/json' } })
  }
  try {
    const responses = await Promise.all([rewriteHelpQuery('cache-org', '取消订阅'), rewriteHelpQuery('cache-org', '取消订阅')])
    assert.equal(requests, 1)
    assert.ok(responses.every(r => r.queries?.[0] === 'cancel subscription' && r.mode === 'bilingual'))
    await rewriteHelpQuery('cache-org', '取消订阅')
    assert.equal(requests, 1)
    globalThis.fetch = async () => { requests++; return new Response('unavailable', { status: 503 }) }
    assert.deepEqual(await rewriteHelpQuery('other-org', '退款'), { mode: 'fallback' })
    assert.equal(requests, 2)
  }
  finally {
    globalThis.fetch = fetchBefore
    for (const key of ['HELP_SEARCH_BILINGUAL', 'OPENAI_API_KEY', 'OPENAI_TEXT_MODEL', 'OPENAI_BASE_URL']) {
      if (before[key] === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = before[key]
    }
  }
})
