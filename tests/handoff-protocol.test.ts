import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HandoffProtocolError, handoffTextGate, hasHandoffProtocolLeak } from '../server/lib/agent/handoff-protocol'
import { collectConversationReply } from '../server/lib/agent/stream'
import { historyProcessor } from '../server/lib/agent/agent'
import type { MastraDBMessage } from '@mastra/core/agent'
import type { UIMessageChunk } from 'ai'

test('split malformed protocol never becomes a visible answer and preserves its typed failure', async () => {
  const gate = handoffTextGate(), shown: string[] = []
  const stream = new ReadableStream<UIMessageChunk>({ start(c) {
    c.enqueue({ type: 'start', messageId: 'x' }); c.enqueue({ type: 'text-start', id: 't' })
    for (const delta of ['func', 'tions.', 'handoff_to_', 'human', ' {"reason":"support_rule"}']) c.enqueue({ type: 'text-delta', id: 't', delta })
    c.enqueue({ type: 'text-end', id: 't' }); c.enqueue({ type: 'finish', finishReason: 'stop' }); c.close()
  } })
  await assert.rejects(collectConversationReply(stream, 'x', chunk => {
    if (chunk.type === 'text-delta') { const text = gate.push(chunk.delta); if (text) shown.push(text) }
  }), HandoffProtocolError)
  assert.deepEqual(shown, [])
})
test('ordinary answers keep streaming without a whole-response buffer', () => {
  const gate = handoffTextGate()
  assert.equal(gate.push('你好'), '你好')
  assert.equal(gate.push('，我可以帮你。'), '，我可以帮你。')
  assert.equal(gate.finish(), '')
  assert.equal(hasHandoffProtocolLeak('You can ask to speak to support.'), false)
})
test('poisoned tool text and subsequent unsupported assistant claims are excluded from model history', async () => {
  const messages = ['我要退款，帮我操作', 'functions.handoff_to_human {"reason":"support_rule"}', '你这是个啥回复', '我已经转人工了'].map((text, index) => ({
    id: String(index), role: index % 2 ? 'assistant' : 'user', createdAt: new Date(index),
    content: { format: 2, parts: [{ type: 'text', text }], metadata: index % 2 ? { feedlogRunId: String(index) } : { feedlogItemId: String(index) } },
  })) as MastraDBMessage[]
  const processor = historyProcessor('current', new Set(['0', '2']), new Set(['1', '3']))
  const result = await processor.processInput({ messages } as Parameters<typeof processor.processInput>[0])
  assert.deepEqual(result.map(message => message.id), ['0', '2'])
})
