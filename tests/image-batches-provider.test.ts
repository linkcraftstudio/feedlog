import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { MastraDBMessage } from '@mastra/core/agent'
import { createImageBatchAnalyzer, prepareImageBatches } from '../server/lib/agent/image-batches'

test('provider requests contain every image once, carry context, and record all batch usage', async () => {
  const received: number[][] = []
  const imageBytes = Buffer.alloc(100001, 42)
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2kAAAAASUVORK5CYII=', 'base64').copy(imageBytes)
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString())
    assert.equal(body.model, 'mock-vision-model')
    assert.equal(body.tools, undefined)
    assert.equal(body.messages[1].content[0].text, 'Compare the ten settings screenshots')
    const numbers = body.messages[1].content
      .filter((part: { type: string; text?: string }) => part.type === 'text' && part.text?.startsWith('Image '))
      .map((part: { text: string }) => Number(part.text.slice(6)))
    assert.equal(body.messages[1].content.filter((part: { type: string }) => part.type === 'image_url').length, numbers.length)
    for (const part of body.messages[1].content.filter((p: { type: string }) => p.type === 'image_url')) {
      assert.equal(part.image_url.detail, 'high')
      assert.deepEqual(Buffer.from(part.image_url.url.split(',')[1], 'base64'), imageBytes)
    }
    received.push(numbers)
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({
      id: 'mock', object: 'chat.completion', created: 0, model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({
        images: numbers.map((image: number) => ({ image, observations: `Screenshot ${image}`, uncertainty: '' })),
      }) } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const saved = Object.fromEntries(['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_TEXT_MODEL'].map(key => [key, process.env[key]]))
  try {
    process.env.OPENAI_API_KEY = 'synthetic-test-key'
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    process.env.OPENAI_TEXT_MODEL = 'mock-vision-model'
    const usage: { inputTokens?: number; outputTokens?: number }[] = []
    const input: MastraDBMessage = {
      id: 'input', threadId: 'thread', role: 'user', createdAt: new Date(),
      content: { format: 2, parts: [] },
    }
    const refs = Array.from({ length: 10 }, (_, i) => ({ index: i + 1, key: String(i), bytes: 100001, etag: '' }))
    const output = await prepareImageBatches(input, refs, 'Compare the ten settings screenshots', new AbortController().signal,
      createImageBatchAnalyzer(async step => { usage.push(step) }), async ref => ({ ...ref, data: `data:image/png;base64,${imageBytes.toString('base64')}` }))
    assert.deepEqual(received.map(batch => batch.length), [10])
    assert.deepEqual(received.flat().sort((a, b) => a - b), Array.from({ length: 10 }, (_, i) => i + 1))
    assert.equal(output.content.parts.length, 1)
    assert.ok(output.content.parts.every(part => part.type === 'text'))
    assert.deepEqual(usage, [{ inputTokens: 100, outputTokens: 50 }])
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('SDK propagates cancellation and does not automatically retry provider failures', async () => {
  let calls = 0, opened!: () => void
  const ready = new Promise<void>(resolve => { opened = resolve })
  const server = createServer((request, response) => {
    calls++
    request.resume()
    if (calls === 1) { response.writeHead(503); response.end('unavailable') }
    else opened()
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const saved = Object.fromEntries(['OPENAI_API_KEY', 'OPENAI_BASE_URL'].map(key => [key, process.env[key]]))
  try {
    process.env.OPENAI_API_KEY = 'synthetic-test-key'
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    const analyzer = createImageBatchAnalyzer(async () => {})
    const images = [{ index: 1, bytes: 1, data: 'data:image/png;base64,AA==' }]
    await assert.rejects(analyzer(images, '', new AbortController().signal))
    assert.equal(calls, 1)
    const controller = new AbortController()
    const result = analyzer(images, '', controller.signal)
    const rejected = assert.rejects(result)
    await ready; controller.abort(); await rejected
    assert.equal(calls, 2)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = value
    }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
