import assert from 'node:assert/strict'
import test from 'node:test'
import { emptyToolCallContent } from '../server/lib/agent/model'

test('replaces null content on assistant tool calls only', () => {
  const body = JSON.stringify({ messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'a' }] },
    { role: 'assistant', content: null },
    { role: 'tool', content: 'ok' },
  ] })
  const [user, call, plain, tool] = JSON.parse(emptyToolCallContent(body)).messages
  assert.equal(user.content, 'hi')
  assert.equal(call.content, '')
  assert.equal(plain.content, null)
  assert.equal(tool.content, 'ok')
})

test('leaves text on assistant tool calls', () => {
  const body = JSON.stringify({ messages: [{ role: 'assistant', content: 'text', tool_calls: [{ id: 'a' }] }] })
  assert.equal(JSON.parse(emptyToolCallContent(body)).messages[0].content, 'text')
})
