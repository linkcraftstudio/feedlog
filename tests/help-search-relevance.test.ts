import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseHelpEvidence, preservesMixedHelpTerms, verifyHelpEvidence } from '../server/lib/help-search/relevance'

const candidates = [{ id: 'article', title: 'Subscription', content: 'Your current plan remains active until the end of the billing cycle.' }]

test('mixed queries cannot match a document missing their literal platform or identifier', () => {
  assert.equal(preservesMixedHelpTerms('取消订阅能删除Instagram账号吗', candidates[0]!), false)
  assert.equal(preservesMixedHelpTerms('取消订阅', candidates[0]!), true)
  assert.equal(preservesMixedHelpTerms('instagram互动率怎么算', { id: 'metrics', title: 'Instagram metrics', content: 'The rate excludes pinned posts.' }), true)
  assert.equal(preservesMixedHelpTerms('修改AUTH_SECRET', { id: 'auth', title: 'Authorization', content: 'Set AUTH_SECRET in the environment.' }), true)
})

test('evidence requires exact source text, known unique IDs and bounded quotes', () => {
  const valid = { matches: [{ id: 'article', quotes: [candidates[0]!.content] }] }
  assert.equal(parseHelpEvidence(JSON.stringify(valid), candidates).length, 1)
  assert.deepEqual(parseHelpEvidence('{"matches":[]}', candidates), [])
  for (const matches of [
    [{ id: 'foreign', quotes: [candidates[0]!.content] }],
    [{ id: 'article', quotes: ['Refunds are automatic and guaranteed.'] }],
    [{ id: 'article', quotes: ['active'] }],
    [{ id: 'article', quotes: [] }],
    [valid.matches[0], valid.matches[0]],
  ]) assert.throws(() => parseHelpEvidence(JSON.stringify({ matches }), candidates))
})

test('provider or output failure never releases unverified candidates as matches', async () => {
  const keys = ['OPENAI_API_KEY', 'OPENAI_TEXT_MODEL', 'OPENAI_BASE_URL'] as const
  const before = { ...process.env }, fetchBefore = globalThis.fetch
  let calls = 0
  Object.assign(process.env, { OPENAI_API_KEY: 'test', OPENAI_TEXT_MODEL: 'test', OPENAI_BASE_URL: 'https://example.invalid/v1' })
  try {
    globalThis.fetch = async () => { calls++; return new Response('unavailable', { status: 503 }) }
    const failed = await verifyHelpEvidence('cancel subscription', candidates)
    assert.equal(failed.status, 'unavailable')
    assert.deepEqual(failed.matches, [])
    assert.equal(calls, 1, 'no provider retry')
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"matches":[{"id":"foreign","quotes":["invented document evidence"]}]}' } }] }), { headers: { 'content-type': 'application/json' } })
    assert.equal((await verifyHelpEvidence('cancel subscription', candidates)).status, 'unavailable')
    const empty = await verifyHelpEvidence('cancel subscription', [])
    assert.equal(empty.status, 'verified')
    assert.deepEqual(empty.matches, [])
  }
  finally {
    globalThis.fetch = fetchBefore
    for (const key of keys) {
      if (before[key] === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = before[key]
    }
  }
})
