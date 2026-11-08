import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startStreamHeartbeat } from '../server/lib/agent/stream-heartbeat'
import { createRunActivity } from '../server/lib/agent/run-activity'
import { readAgentEvents } from '../shared/agent/sse'

test('transport heartbeats do not reach the UI or extend the first-answer deadline', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 1000 })
  const activity = createRunActivity(Date.now() + 120_000)
  const frames: string[] = []
  let closed = () => {}
  startStreamHeartbeat({
    async push(message) { frames.push(`event: ${message.event}\ndata: ${message.data}\n\n`) },
    onClosed(callback) { closed = callback },
  })
  for (let i = 0; i < 12; i++) {
    t.mock.timers.tick(10_000)
    await new Promise<void>(resolve => queueMicrotask(resolve))
    await new Promise<void>(resolve => queueMicrotask(resolve))
    assert.equal(activity.deadline(), 121000)
  }
  assert.equal(activity.signal.aborted, true)
  assert.equal(frames.length, 12)
  let visibleEvents = 0
  await readAgentEvents(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(frames.join('')))
    controller.close()
  } }), () => { visibleEvents++ })
  assert.equal(visibleEvents, 0)
  closed()
  t.mock.timers.tick(30_000)
  assert.equal(frames.length, 12)
  activity.dispose()
})

test('a blocked socket cannot accumulate heartbeat writes', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let writes = 0
  let release = () => {}
  const stop = startStreamHeartbeat({
    push() { writes++; return new Promise<void>(resolve => { release = resolve }) },
    onClosed() {},
  })
  t.mock.timers.tick(120_000)
  assert.equal(writes, 1)
  stop()
  release()
  await new Promise<void>(resolve => queueMicrotask(resolve))
  t.mock.timers.tick(30_000)
  assert.equal(writes, 1)
})
