import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { watchRun } from '../server/lib/agent/run-monitor'

test('100 active runs share one status query and removed listeners are not called', async () => {
  let queries = 0, checked = 0, active = 0, stopped = 0
  const pool = { async query(_sql: string, [ids]: [string[]]) { queries++; checked = ids.length; return { rows: ids.filter(id => id !== '99').map(id => ({ id })) } } } as unknown as Pool
  const stop = Array.from({ length: 100 }, (_, i) => watchRun(pool, String(i), async () => { active++ }, () => { stopped++ }))
  stop[0]!()
  try {
    await new Promise(resolve => setTimeout(resolve, 1100))
    assert.equal(queries, 1); assert.equal(checked, 99); assert.equal(active, 98); assert.equal(stopped, 1)
  } finally { stop.forEach(fn => fn()) }
  await new Promise(resolve => setTimeout(resolve, 1100))
  assert.equal(queries, 1)
})
