// node --experimental-test-module-mocks --import tsx tests/help-index-dispatch.test.ts
import assert from 'node:assert/strict'
import { after, mock, test } from 'node:test'
import type { H3Event } from 'h3'

const calls: string[] = []
let queueFails = false
let modelFails = false
let presetCloudflare = false
const oldEnabled = process.env.HELP_VECTOR_SEARCH
const oldDatabase = process.env.DATABASE_URL
mock.module('pg', { namedExports: { Pool: class { async end() { calls.push('pool:end') } } } })
mock.module('../server/lib/help-search/indexer.ts', { namedExports: {
  async indexNextHelpArticle(_pool: unknown, _embed: unknown, _onClaim: unknown, articleId: string) {
    calls.push(`index:${articleId}`)
    if (modelFails) throw new Error('Synthetic index failure')
    return { processed: true }
  },
} })
mock.module('../server/lib/inbox/platform.ts', { namedExports: {
  schedulerContext(event: H3Event) {
    const cloudflare = event.context.cloudflare ?? event.context._platform?.cloudflare
    return cloudflare || presetCloudflare ? { cloudflare: cloudflare ?? {} } : {}
  },
  async requestSchedule(_event: unknown, _context: unknown, strict: boolean) {
    calls.push('schedule')
    if (queueFails && strict) throw new Error('Synthetic queue failure')
  },
} })
const { kickHelpIndex } = await import('../server/lib/help-search/runtime')
after(() => {
  if (oldEnabled === undefined) delete process.env.HELP_VECTOR_SEARCH
  else process.env.HELP_VECTOR_SEARCH = oldEnabled
  if (oldDatabase === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = oldDatabase
  mock.restoreAll()
})
async function save(context: Record<string, unknown> = {}, enabled = true) {
  calls.length = 0
  process.env.HELP_VECTOR_SEARCH = String(enabled)
  process.env.DATABASE_URL = 'postgresql://unused-local-fixture'
  const pending: Promise<unknown>[] = []
  const event = { context, waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as unknown as H3Event
  assert.equal(kickHelpIndex(event, 'saved-article'), undefined)
  await Promise.all(pending)
}
test('Cloudflare save and forwarded admin retry only reserve the queue wake', async () => {
  for (const context of [{ cloudflare: { env: {} } }, { _platform: { cloudflare: { env: {} } } }]) {
    await save(context)
    assert.deepEqual(calls, ['schedule'])
  }
})
test('Cloudflare preset fallback also skips the HTTP indexer', async () => {
  presetCloudflare = true
  try { await save(); assert.deepEqual(calls, ['schedule']) }
  finally { presetCloudflare = false }
})
test('Node and Vercel keep immediate indexing of the saved article and recovery wake', async () => {
  for (const context of [{}, { vercel: {} }]) {
    await save(context)
    assert.deepEqual(calls, ['schedule', 'index:saved-article', 'pool:end', 'schedule'])
  }
})
test('failed wake reservation does not start unprotected indexing or reject article save', async () => {
  queueFails = true
  try {
    for (const context of [{}, { cloudflare: { env: {} } }]) {
      await save(context)
      assert.deepEqual(calls, ['schedule'])
    }
  } finally { queueFails = false }
})
test('immediate indexing failure closes the pool and requests recovery', async () => {
  modelFails = true
  try { await save(); assert.deepEqual(calls, ['schedule', 'index:saved-article', 'pool:end', 'schedule']) }
  finally { modelFails = false }
})
test('disabled semantic search neither schedules nor indexes', async () => {
  await save({ cloudflare: { env: {} } }, false)
  assert.deepEqual(calls, [])
})
