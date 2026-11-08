import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { summarizeHandoffQuestion } from '../server/lib/inbox/email-context'

test('handoff summary uses conversation context and falls back when the provider fails', async () => {
  let failing = false
  let received = ''
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    received = Buffer.concat(chunks).toString()
    response.setHeader('content-type', 'application/json')
    if (failing) { response.statusCode = 400; response.end(JSON.stringify({ error: { message: 'Synthetic failure' } })); return }
    response.end(JSON.stringify({ id: 'mock', object: 'chat.completion', created: 0, model: 'mock-summary',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'The customer reports duplicate charges and wants a refund.' } }],
      usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 } }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const saved = Object.fromEntries(['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_TEXT_MODEL'].map(key => [key, process.env[key]]))
  try {
    process.env.OPENAI_API_KEY = 'synthetic-test-key'
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    process.env.OPENAI_TEXT_MODEL = 'mock-summary'
    const messages = [{ author_type: 'customer', content: { parts: [{ type: 'text' as const, text: '我被扣了两次款，请退回多扣的费用。' }] } }]
    assert.equal(await summarizeHandoffQuestion(messages), 'The customer reports duplicate charges and wants a refund.')
    assert.ok(received.includes('我被扣了两次款'))
    assert.ok(received.includes('in English, regardless of the language'))
    failing = true
    assert.equal(await summarizeHandoffQuestion(messages), '')
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
