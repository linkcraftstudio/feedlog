import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRunActivity } from '../server/lib/agent/run-activity'
import { collectConversationReply } from '../server/lib/agent/stream'
import type { UIMessageChunk } from 'ai'

test('a real UI message stream continues for five minutes while text arrives', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
  const activity = createRunActivity(Date.now() + 120000)
  try {
    const chunks: UIMessageChunk[] = [{ type: 'start', messageId: 'reply' }, { type: 'text-start', id: 'text' }]
    for (let i = 0; i < 10; i++) chunks.push({ type: 'text-delta', id: 'text', delta: `${i} ` })
    chunks.push({ type: 'text-end', id: 'text' }, { type: 'finish', finishReason: 'stop' })
    const reply = await collectConversationReply(new ReadableStream({
      pull(controller) {
        const next = chunks.shift()
        if (!next) { controller.close(); return }
        if (next.type === 'text-delta') t.mock.timers.tick(30000)
        controller.enqueue(next)
      },
    }), 'reply', async chunk => {
      if (chunk.type === 'text-delta' && chunk.delta.length) activity.answer('text')
      assert.equal(activity.signal.aborted, false)
    })
    assert.ok(Date.now() > 300000)
    assert.deepEqual(reply.message.parts, [{ type: 'text', text: '0 1 2 3 4 5 6 7 8 9 ', state: 'done', providerMetadata: undefined }])
  } finally { activity.dispose() }
})

test('no first response times out at 120 seconds; a late response cannot revive it', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
  const activity = createRunActivity(Date.now() + 120000)
  t.mock.timers.tick(119999)
  assert.equal(activity.signal.aborted, false)
  t.mock.timers.tick(1)
  assert.equal(activity.signal.aborted, true)
  activity.answer('text')
  assert.equal(activity.signal.aborted, true)
  activity.dispose()
})

test('background work and empty deltas cannot renew the first-answer deadline', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
  const activity = createRunActivity(Date.now() + 120000)
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(30000)
    activity.answer('')
    assert.equal(activity.deadline(), 121000)
  }
  t.mock.timers.tick(30000)
  assert.equal(activity.signal.aborted, true)
  activity.dispose()
})

test('a first answer at 119 seconds starts its own idle window', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
  const activity = createRunActivity(Date.now() + 120000)
  t.mock.timers.tick(119000)
  activity.answer('Answer')
  t.mock.timers.tick(119999)
  assert.equal(activity.signal.aborted, false)
  t.mock.timers.tick(1)
  assert.equal(activity.signal.aborted, true)
  activity.dispose()
})
