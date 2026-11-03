import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { Pool } from 'pg'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { uuidv7 } from 'uuidv7'
import { startRun } from '../server/lib/agent/conversations'
import type { Actor } from '../server/lib/agent/runtime'
import { handoff } from '../server/lib/inbox/service'
import { inboxTick } from '../server/lib/inbox/tick'
import { publicItem } from '../server/lib/agent/runtime'
import { registerEmailProvider, type SendEmailOptions } from '../server/utils/email'

const url = process.env.DATABASE_URL ?? ''
assert.match(url, /@(?:localhost|127\.0\.0\.1):\d+\/feedlog_inbox_mvp$/)
const admin = new Pool({ connectionString: url })
const database = `feedlog_inbox_fix_${Date.now()}`
const target = new URL(url); target.pathname = `/${database}`
const pool = new Pool({ connectionString: target.toString() })
const runtime = { pool }
const emails: SendEmailOptions[] = []
let failOwner = false
const oldProvider = process.env.EMAIL_PROVIDER
before(async () => {
  await admin.query(`CREATE DATABASE "${database}"`)
  const connection = postgres(target.toString(), { max: 1 })
  try { await migrate(drizzle(connection), { migrationsFolder: 'server/db/migrations' }) }
  finally { await connection.end() }
  await pool.query(`INSERT INTO organization(id,name,slug) VALUES ('org','Product','org'),('other','Other','other');
    INSERT INTO "user"(id,name,email) VALUES ('customer','Customer','customer@example.com'),('owner','Owner','owner@example.com'),
      ('second-owner','Second owner','second-owner@example.com'),('manager','Manager','manager@example.com'),('contributor','Contributor','contributor@example.com'),('other','Other','other@example.com');
    INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES ('owner','org','owner','owner',now()),
      ('second-owner','org','second-owner','owner',now()),('manager','org','manager','manager',now()),('contributor','org','contributor','contributor',now()),('other','other','other','owner',now())`)
  registerEmailProvider({ name: 'handoff-test', async send(email) {
    if (failOwner && email.to === 'second-owner@example.com') throw new Error('Synthetic failure')
    emails.push(email)
  } })
  process.env.EMAIL_PROVIDER = 'handoff-test'
})
after(async () => {
  if (oldProvider === undefined) delete process.env.EMAIL_PROVIDER
  else process.env.EMAIL_PROVIDER = oldProvider
  await pool.end()
  await admin.query(`DROP DATABASE "${database}"`)
  await admin.end()
})
const actor = { orgId: 'org', customerId: 'customer', retentionDays: 14 } as Actor
async function conversation() {
  const id = uuidv7()
  const execution = await startRun(runtime, id, actor, { action: 'send', idempotency_key: uuidv7(),
    message: { id: uuidv7(), content: { parts: [{ type: 'text', text: 'A private question' }] }, context: null } })
  return { id, runId: execution.run!.id }
}

test('successful handoff creates one durable email task and only notifies same-tenant owners', async () => {
  const f = await conversation()
  const notice = await handoff(runtime, f.id, 'org', f.runId, 'user_requested', false, undefined, [], 'https://support.example.invalid')
  assert.equal(publicItem(notice)?.notice, 'handoff')
  await handoff(runtime, f.id, 'org', f.runId, 'user_requested')
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM scheduled_task WHERE kind='inbox_handoff_email' AND ref_id=$1", [f.runId])).rows[0].n, 1)
  await inboxTick(runtime)
  assert.deepEqual(emails.map(e => e.to).sort(), ['owner@example.com', 'second-owner@example.com'])
  assert.ok(emails.every(e => e.html.includes(`conversationId=${f.id}`)))
  assert.ok(emails.every(e => e.html.includes('A private question') && e.html.includes('Customer') && e.html.includes('customer@example.com')))
  await inboxTick(runtime)
  assert.equal(emails.length, 2)
})

test('a partial delivery retries only failed recipients, and missing-AI fallback stays silent', async () => {
  emails.length = 0; failOwner = true
  const f = await conversation()
  const notice = await handoff(runtime, f.id, 'org', f.runId, 'ai_error', true, undefined, [], 'https://support.example.invalid')
  assert.equal(publicItem(notice), null)
  await inboxTick(runtime)
  assert.ok(emails[0]!.html.includes('AI unavailable'))
  assert.ok(emails[0]!.html.includes('A private question'))
  assert.ok(!emails[0]!.html.includes('ISSUE SUMMARY'))
  assert.deepEqual(emails.map(e => e.to), ['owner@example.com'])
  const task = (await pool.query("SELECT * FROM scheduled_task WHERE kind='inbox_handoff_email' AND ref_id=$1", [f.runId])).rows[0]
  assert.equal(JSON.parse(task.result).context.lastMessage, 'A private question')
  assert.equal(task.status, 'pending')
  failOwner = false
  await pool.query('UPDATE scheduled_task SET schedule_at=clock_timestamp() WHERE id=$1', [task.id])
  await inboxTick(runtime)
  assert.deepEqual(emails.map(e => e.to).sort(), ['owner@example.com', 'second-owner@example.com'])
  assert.equal((await pool.query('SELECT status FROM scheduled_task WHERE id=$1', [task.id])).rows[0].status, 'done')
})

test('no support staff means no false transfer notice or administrator mail', async () => {
  const f = await conversation()
  await pool.query("DELETE FROM member WHERE organization_id='org'")
  const notice = await handoff(runtime, f.id, 'org', f.runId, 'ai_error', true)
  assert.equal(notice, null)
  assert.equal((await pool.query('SELECT status FROM conversation WHERE id=$1', [f.id])).rows[0].status, 'ai_handling')
  assert.equal((await pool.query('SELECT error FROM agent_run WHERE id=$1', [f.runId])).rows[0].error, 'support_unavailable')
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM scheduled_task WHERE kind='inbox_handoff_email' AND ref_id=$1", [f.runId])).rows[0].n, 0)
})

test('an expired first-answer budget rolls back the message instead of starting a late run', async () => {
  const id = uuidv7()
  await assert.rejects(startRun(runtime, id, actor, {
    action: 'send', idempotency_key: uuidv7(),
    message: { id: uuidv7(), content: { parts: [{ type: 'text', text: 'Delayed image preflight' }] }, context: null },
  }, Date.now() - 1), (error: unknown) => (error as { data?: { code?: string } }).data?.code === 'ai_timeout')
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_run WHERE conversation_id=$1', [id])).rows[0].n, 0)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM conversation_item WHERE conversation_id=$1', [id])).rows[0].n, 0)
})
