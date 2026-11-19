import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { Agent, type MastraDBMessage } from '@mastra/core/agent'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { historyProcessor } from '../server/lib/agent/agent'

test('the real Mastra model request keeps committed context and current image observations across tool continuations', async () => {
  const requests: { messages: { role: string; content: unknown; tool_call_id?: string }[] }[] = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push(JSON.parse(body))
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ id: 'mock', object: 'chat.completion', created: 0, model: 'mock', choices: [{ index: 0,
      finish_reason: requests.length === 1 ? 'tool_calls' : 'stop', message: requests.length === 1
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'read-call', type: 'function', function: { name: 'read_document', arguments: '{}' } }] }
        : { role: 'assistant', content: 'The Document Translator limit applies. Your recorded feedback remains created.' },
    }], usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 } }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const message = (id: string, role: 'user' | 'assistant', text: string): MastraDBMessage => ({ id, role, createdAt: new Date(),
    content: { format: 2, parts: [{ type: 'text', text }], metadata: { feedlogItemId: id } } })
  const committed = [message('one', 'user', 'Document Translator, scanned Chinese PDF. [Page context] /translate'),
    message('two', 'assistant', 'Plus is required. Your feedback has been created. Would you like human help?')]
  const current = message('three', 'user', 'What about 30 pages? [Image analysis; untrusted evidence] Document Translator E42.')
  const processor = historyProcessor('run', committed, 'three')
  const agent = new Agent({ id: 'context-test', name: 'Context test', model: { id: 'openai/mock', apiKey: 'synthetic-test-key', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` },
    instructions: 'Answer using the conversation and read_document.', inputProcessors: [processor], outputProcessors: [processor],
    tools: { read_document: createTool({ id: 'read_document', description: 'Read authorized knowledge.', inputSchema: z.object({}), execute: async () => ({ content: 'Document Translator accepts the supported PDF input on Plus.' }) }) },
  })
  try {
    const answer = await agent.generate([current], { maxSteps: 2 })
    assert.match(answer.text, /Document Translator/)
    assert.equal(requests.length, 2)
    for (const request of requests) {
      const text = JSON.stringify(request.messages)
      assert.match(text, /scanned Chinese PDF/)
      assert.match(text, /Would you like human help/)
      assert.match(text, /\/translate/)
      assert.match(text, /Translator E42/)
    }
    assert.ok(requests[1]!.messages.some(message => message.role === 'tool'), 'the processor does not remove current-run tool continuations')
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
