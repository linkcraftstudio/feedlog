import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentDependencyTimeout, withDependencyTimeout } from '../server/lib/agent/dependency-timeout'

test('a stalled read fails after five seconds and ignores late results', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let finish!: (value: string) => void
  const pending = withDependencyTimeout(() => new Promise<string>(resolve => { finish = resolve }), new AbortController().signal)
  const rejected = assert.rejects(pending, AgentDependencyTimeout)
  await Promise.resolve()
  t.mock.timers.tick(5000)
  await rejected
  finish('late evidence')
})
test('the first-answer abort also interrupts a dependency still within its own budget', async () => {
  const controller = new AbortController()
  const pending = withDependencyTimeout(() => new Promise(() => {}), controller.signal)
  const rejected = assert.rejects(pending, /First answer expired/)
  controller.abort(new Error('First answer expired'))
  await rejected
})
test('a prompt dependency completes normally', async () => {
  assert.equal(await withDependencyTimeout(async () => 'evidence', new AbortController().signal), 'evidence')
})
