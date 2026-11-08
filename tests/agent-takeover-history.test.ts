import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { H3Event } from 'h3'
import { uuidv7 } from 'uuidv7'
import { agentRuntime, transaction, appendItem, type Actor } from '../server/lib/agent/runtime'
import { customerMemoryMessage, prepareAgent } from '../server/lib/agent/agent'
import { startRun, failRun } from '../server/lib/agent/conversations'
import { staffCommand } from '../server/lib/inbox/service'
import { chatInput } from '../shared/agent/content'

assert.match(process.env.DATABASE_URL ?? '', /@(?:localhost|127\.0\.0\.1):\d+\/feedlog_inbox_mvp$/)
const event = { context: {}, node: { req: { headers: { host: 'localhost' }, url: '/' } } } as H3Event
const runtime = agentRuntime(event)
const { pool, memory } = runtime
after(() => runtime.close())

test('a reopened AI round receives human-phase customer messages and staff replies exactly once', { timeout: 30000 }, async () => {
  const orgId = `takeover-history-${uuidv7()}`, userId = uuidv7(), staffId = uuidv7(), id = uuidv7()
  const resourceId = `${orgId}:${id}`
  const actor = { orgId, customerId: userId, retentionDays: 14, session: { user: { id: userId } } } as Actor
  const send = (text: string) => chatInput.parse({ action: 'send', idempotency_key: uuidv7(), message: { id: uuidv7(), content: { parts: [{ type: 'text', text }] } } })
  const command = async (action: 'takeover' | 'close' | 'reply') => {
    const { rows: [row] } = await pool.query('SELECT last_seq FROM conversation WHERE id=$1', [id])
    const base = { requestId: uuidv7(), expectedLastSeq: Number(row.last_seq) }
    return staffCommand(runtime, id, orgId, staffId, action === 'reply'
      ? { ...base, action, content: { parts: [{ type: 'text', text: 'STAFF_RESULT: replacement approved.' }] } }
      : { ...base, action })
  }
  let received = ''
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    received = Buffer.concat(chunks).toString()
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const choice of [
      { delta: { role: 'assistant', content: 'Acknowledged.' }, finish_reason: null },
      { delta: {}, finish_reason: 'stop' },
    ]) response.write(`data: ${JSON.stringify({ id: 'synthetic-history-test', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini', choices: [{ index: 0, ...choice }] })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  const saved = Object.fromEntries(['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_TEXT_MODEL'].map(key => [key, process.env[key]]))
  try {
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
    process.env.OPENAI_API_KEY = 'synthetic-local-test-key'
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`
    process.env.OPENAI_TEXT_MODEL = 'gpt-4o-mini'
    await pool.query('INSERT INTO organization(id,name,slug) VALUES ($1,$1,$1)', [orgId])
    for (const uid of [userId, staffId]) await pool.query('INSERT INTO "user"(id,name,email) VALUES ($1,$1,$2)', [uid, `${uid}@example.invalid`])
    const first = await startRun(runtime, id, actor, send('ORIGINAL_QUESTION: check my delivery.'))
    await memory.createThread({ threadId: id, resourceId, title: 'Synthetic history test' })
    const originalInput = await customerMemoryMessage(event, first.item, resourceId, orgId)
    originalInput.content.parts.push({ type: 'text', text: 'PRESERVED_OBSERVATION: package damage was already analyzed.' })
    await memory.saveMessages({ messages: [
      originalInput,
      { id: uuidv7(), threadId: id, resourceId, role: 'assistant', createdAt: new Date(), content: { format: 2, parts: [{ type: 'text', text: 'COMPLETED_ANSWER: please share the order number.' }], metadata: { feedlogRunId: first.run!.id } } },
    ] })
    await transaction(runtime, async client => {
      await appendItem(client, { id: uuidv7(), conversationId: id, author: 'agent', runId: first.run!.id, content: { parts: [{ type: 'text', text: 'COMPLETED_ANSWER: please share the order number.' }] } })
      await client.query("UPDATE agent_run SET status='completed',finished_at=clock_timestamp() WHERE id=$1", [first.run!.id])
    })
    const cancelled = await startRun(runtime, id, actor, send('BEFORE_TAKEOVER: I need help.'))
    await memory.saveMessages({ messages: [{ id: uuidv7(), threadId: id, resourceId, role: 'assistant', createdAt: new Date(), content: { format: 2, parts: [{ type: 'text', text: 'CANCELLED_OUTPUT: this must never enter model context.' }], metadata: { feedlogRunId: cancelled.run!.id } } }] })
    await command('takeover')
    await failRun(runtime, cancelled.run!.id, 'synthetic_failure')
    const humanMessage = await startRun(runtime, id, actor, send('HUMAN_DETAIL: order ZX-42 arrived damaged.'))
    assert.equal(humanMessage.run, null)
    await command('reply')
    await command('close')
    const reopened = await startRun(runtime, id, actor, send('FOLLOWUP: what happens with that replacement?'))
    const prepare = () => prepareAgent(event, actor, id, reopened.run!, reopened.item, new AbortController().signal, () => {})
    await prepare()
    const prepared = await prepare()
    const { rows: entries } = await pool.query('SELECT id,role,content::jsonb AS content FROM mastra_messages WHERE thread_id=$1', [id])
    const humanEntries = entries.filter(entry => entry.content.metadata?.feedlogItemId === humanMessage.item.id)
    assert.equal(humanEntries.length, 1)
    assert.equal(humanEntries[0]!.role, 'user')
    const output = await prepared.agent.stream([prepared.input], { runId: reopened.run!.id, memory: { thread: id, resource: resourceId, options: { lastMessages: prepared.historySize } }, maxSteps: 1 })
    assert.equal(await output.text, 'Acknowledged.')
    await memory.settled()
    const body = JSON.parse(received)
    const messages = JSON.stringify(body.messages)
    for (const marker of ['ORIGINAL_QUESTION', 'PRESERVED_OBSERVATION', 'COMPLETED_ANSWER', 'BEFORE_TAKEOVER', 'HUMAN_DETAIL', 'STAFF_RESULT', 'FOLLOWUP']) {
      assert.equal(messages.split(marker).length - 1, 1, marker)
    }
    assert.ok(!messages.includes('CANCELLED_OUTPUT'))
    assert.ok(body.messages.some((message: { role: string; content: unknown }) => message.role === 'user' && JSON.stringify(message.content).includes('HUMAN_DETAIL')))
    assert.ok(body.messages.some((message: { role: string; content: unknown }) => message.role === 'assistant' && JSON.stringify(message.content).includes('STAFF_RESULT')))
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
    provider.closeAllConnections()
    await new Promise<void>(resolve => provider.close(() => resolve()))
    await memory.settled()
    await pool.query('DELETE FROM mastra_messages WHERE thread_id=$1', [id])
    await pool.query('DELETE FROM mastra_threads WHERE id=$1', [id])
    await pool.query('DELETE FROM scheduled_task WHERE ref_id=$1 OR ref_id IN (SELECT id FROM agent_run WHERE conversation_id=$1)', [id])
    await pool.query("DELETE FROM conversation_item WHERE conversation_id=$1 AND author_type='agent'", [id])
    await pool.query('DELETE FROM agent_run WHERE conversation_id=$1', [id])
    await pool.query('DELETE FROM conversation_item WHERE conversation_id=$1', [id])
    await pool.query('DELETE FROM conversation WHERE id=$1', [id])
    await pool.query('DELETE FROM organization WHERE id=$1', [orgId])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [[userId, staffId]])
  }
})
