import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { Pool } from 'pg'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { uuidv7 } from 'uuidv7'
import { scheduleInbox, consumeInbox, wakeAt, isQuotaExhausted, type WakeMessage, type DelayTransport } from '../server/lib/inbox/scheduler'
import { markCustomerRead } from '../server/lib/inbox/read'
import { inboxTick } from '../server/lib/inbox/tick'
import { staffCommand } from '../server/lib/inbox/service'
import { automaticRetryDelayMs, retryReplyEmail, deliverReplyNow } from '../server/lib/inbox/email'
import { registerEmailProvider, type SendEmailOptions } from '../server/utils/email'
import { readInbox } from '../server/lib/inbox/queries'
import { pageInput } from '../shared/inbox/schemas'
import { queueHelpIndex, deleteHelpIndex } from '../server/lib/help-search/jobs'

const url = process.env.DATABASE_URL ?? ''
assert.match(url, /@(?:localhost|127\.0\.0\.1):\d+\/feedlog_inbox_mvp$/)
const admin = new Pool({ connectionString: url })
const database = `feedlog_inbox_mvp_scheduler_${Date.now()}`
const target = new URL(url); target.pathname = `/${database}`
const pool = new Pool({ connectionString: target.toString(), max: 6 })
const runtime = { pool }
const deliveries: { message: WakeMessage; seconds: number }[] = []
const emails: SendEmailOptions[] = []
let failEmail = false
let failQueue: Error | undefined
const transport: DelayTransport = { maxDelaySeconds: 23 * 3600, async send(message, seconds) {
  if (failQueue) throw failQueue
  deliveries.push({ message, seconds })
} }
const oldProvider = process.env.EMAIL_PROVIDER
before(async () => {
  await admin.query(`CREATE DATABASE "${database}"`)
  const connection = postgres(target.toString(), { max: 1 })
  try { await migrate(drizzle(connection), { migrationsFolder: 'server/db/migrations' }) }
  finally { await connection.end() }
  await pool.query(`INSERT INTO organization(id,name,slug) VALUES ('org','Org','org');
    INSERT INTO "user"(id,name,email) VALUES ('customer','Customer','customer@example.com'),('staff','Staff','staff@example.com'),('owner','Owner','owner@example.com');
    INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES ('owner','org','owner','owner',now())`)
  registerEmailProvider({ name: 'scheduler-test', async send(email) { emails.push(email); if (failEmail) throw new Error('Synthetic mail failure') } })
  process.env.EMAIL_PROVIDER = 'scheduler-test'
})
after(async () => {
  if (oldProvider === undefined) delete process.env.EMAIL_PROVIDER
  else process.env.EMAIL_PROVIDER = oldProvider
  await pool.end()
  await admin.query(`DROP DATABASE "${database}"`)
  await admin.end()
})
async function reset() {
  await pool.query('DELETE FROM scheduled_task; DELETE FROM delay_message; DELETE FROM conversation_item; DELETE FROM conversation')
  deliveries.length = 0; emails.length = 0; failEmail = false; failQueue = undefined
}
async function task(status = 'pending', seconds = 60) {
  const id = uuidv7()
  await pool.query(`INSERT INTO scheduled_task(id,kind,ref_id,status,schedule_at) VALUES ($1,'inbox_due',$2,$3,now()+make_interval(secs=>$4))`, [id, uuidv7(), status, seconds])
  return id
}
async function ageMessages() { await pool.query("UPDATE delay_message SET sent_at=sent_at-interval '20 seconds'") }
async function conversation() {
  const id = uuidv7()
  await pool.query("INSERT INTO conversation(id,org_id,user_id,status,last_seq) VALUES ($1,'org','customer','open',1)", [id])
  return id
}
async function reply(id: string, text: string) {
  const { rows: [row] } = await pool.query('SELECT last_seq FROM conversation WHERE id=$1', [id])
  return staffCommand(runtime, id, 'org', 'staff', { action: 'reply', requestId: uuidv7(), expectedLastSeq: Number(row.last_seq), content: { parts: [{ type: 'text', text }] } })
}

test('wake rounding is never early and respects queue limits', () => {
  const now = new Date('2026-09-28T00:00:01Z')
  assert.equal(wakeAt(new Date(+now-1), now, 82800), now)
  assert.equal(wakeAt(new Date('2026-09-28T00:05:01Z'), now, 82800).toISOString(), '2026-09-28T00:10:00.000Z')
  assert.equal(+wakeAt(new Date(+now+40*86400000), now, 82800)-+now, 82800000)
  assert.equal(isQuotaExhausted({ status: 429, message: 'Too many requests' }), false)
  assert.equal(isQuotaExhausted(new Error('Daily message limit exceeded')), true)
  assert.equal(isQuotaExhausted({ code: 10253 }), true)
  assert.equal(isQuotaExhausted(new Error('FreeTierLimitExceeded')), true)
})

test('concurrent public scheduling delivers once; covered work does not change business state', async () => {
  await reset(); await task('pending', 3600)
  await Promise.all([scheduleInbox(runtime, transport), scheduleInbox(runtime, transport)])
  assert.equal(deliveries.length, 1)
  await pool.query("UPDATE delay_message SET expect_at=now()+interval '10 minutes',sent_at=now()-interval '20 seconds'")
  assert.deepEqual(await scheduleInbox(runtime, transport), { scheduled: false, expectAt: null })
  assert.equal((await pool.query('SELECT status FROM scheduled_task')).rows[0].status, 'pending')
})

test('expired processing and invalid states force a new delivery despite coverage', async () => {
  for (const status of ['processing','unexpected']) {
    await reset(); const id = await task(status, 3600)
    await pool.query("UPDATE scheduled_task SET updated_at=now()-interval '11 minutes' WHERE id=$1", [id])
    const previous = uuidv7()
    await pool.query("INSERT INTO delay_message(id,expect_at,sent_at) VALUES ($1,now()+interval '1 minute',now()-interval '20 seconds')", [previous])
    assert.equal((await scheduleInbox(runtime, transport)).scheduled, true)
    assert.equal((await pool.query('SELECT status FROM delay_message WHERE id=$1', [previous])).rows[0].status, 'cancelled')
  }
})

test('quota notices go once to owners, tasks survive errors, successful delivery resets the episode', async () => {
  await reset(); await task()
  failQueue = new Error('quota_exhausted')
  assert.equal((await scheduleInbox(runtime, transport)).scheduled, false)
  assert.equal(emails.length, 1); assert.equal(emails[0]!.to, 'owner@example.com')
  await ageMessages(); await scheduleInbox(runtime, transport)
  assert.equal(emails.length, 1)
  assert.equal((await pool.query('SELECT status FROM scheduled_task')).rows[0].status, 'pending')
  await ageMessages(); failQueue = undefined
  assert.equal((await scheduleInbox(runtime, transport)).scheduled, true)
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM delay_message WHERE status='quota_exhausted'")).rows[0].n, 0)
  await reset(); await task(); failQueue = new Error('network unavailable')
  await scheduleInbox(runtime, transport)
  assert.equal((await pool.query('SELECT status FROM delay_message')).rows[0].status, 'cancelled')
  assert.equal(emails.length, 0)
})

test('consumer accepts each wake once and schedules remaining work without reviving cancelled wakes', async () => {
  await reset(); await task('pending', -1); const later = await task('pending', 3600)
  await scheduleInbox(runtime, transport)
  const original = deliveries[0]!.message
  await consumeInbox(runtime, transport, original)
  assert.equal(deliveries.length, 2)
  assert.equal((await pool.query('SELECT status FROM delay_message WHERE id=$1', [original.id])).rows[0].status, 'fired')
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM delay_message WHERE status='scheduled'")).rows[0].n, 1)
  await consumeInbox(runtime, transport, original)
  assert.equal(deliveries.length, 2)
  const current = deliveries[1]!.message
  await pool.query("UPDATE delay_message SET status='cancelled'")
  await pool.query("UPDATE scheduled_task SET schedule_at=now()-interval '1 second' WHERE id=$1", [later])
  await consumeInbox(runtime, transport, current)
  assert.equal((await pool.query('SELECT status FROM delay_message WHERE id=$1', [current.id])).rows[0].status, 'fired')
  assert.equal((await pool.query('SELECT status FROM scheduled_task WHERE id=$1', [later])).rows[0].status, 'done')
  assert.equal(deliveries.length, 2)
})

test('each reply has its own five-minute task; partial reads skip only the read reply', async () => {
  await reset(); const id = await conversation()
  const first = await reply(id, 'First reply'); const second = await reply(id, 'Second reply')
  const tasks = (await pool.query("SELECT * FROM scheduled_task WHERE kind='inbox_email' ORDER BY schedule_at")).rows
  assert.equal(tasks.length, 2)
  assert.equal(+new Date(tasks[0].schedule_at)-+new Date(first.item.createdAt), 300000)
  await inboxTick(runtime); assert.equal(emails.length, 0)
  assert.equal(await markCustomerRead(runtime, id, 'other-org', 'customer', 14, first.item.seq), undefined)
  assert.equal(await markCustomerRead(runtime, id, 'org', 'staff', 14, first.item.seq), undefined)
  assert.deepEqual(await markCustomerRead(runtime, id, 'org', 'customer', 14, first.item.seq), { cleared: false })
  await markCustomerRead(runtime, id, 'org', 'customer', 14, 1)
  assert.equal(Number((await pool.query('SELECT customer_read_seq FROM conversation WHERE id=$1', [id])).rows[0].customer_read_seq), first.item.seq)
  await pool.query("UPDATE scheduled_task SET schedule_at=now()-interval '1 second' WHERE kind='inbox_email'")
  await Promise.all([inboxTick(runtime), inboxTick(runtime)])
  assert.equal(emails.length, 1)
  assert.match(emails[0]!.text!, /Second reply/)
  assert.doesNotMatch(emails[0]!.text!, /First reply/)
  const detail = await readInbox(runtime, 'org', id, pageInput.parse({}))
  assert.equal(detail.emails[first.item.id].status, 'skipped')
  assert.equal(detail.emails[second.item.id].status, 'accepted')
  await inboxTick(runtime); assert.equal(emails.length, 1)
})

test('unread replies are never merged, and failed mail has exactly two automatic attempts plus one manual retry', async () => {
  await reset(); const id = await conversation()
  await reply(id, 'Separate one'); await reply(id, 'Separate two')
  await pool.query("UPDATE scheduled_task SET schedule_at=now()-interval '1 second' WHERE kind='inbox_email'")
  await inboxTick(runtime)
  assert.equal(emails.length, 2)
  assert.notEqual(emails[0]!.idempotencyKey, emails[1]!.idempotencyKey)
  const third = await reply(id, 'Retry me'); failEmail = true
  await pool.query("UPDATE scheduled_task SET schedule_at=now()-interval '1 second' WHERE item_id=$1", [third.item.id])
  const started = Date.now()
  await inboxTick(runtime); assert.equal(emails.length, 4)
  assert.ok(Date.now() - started >= automaticRetryDelayMs)
  await inboxTick(runtime); assert.equal(emails.length, 4)
  await assert.rejects(retryReplyEmail(runtime, 'other-org', id, third.item.id))
  await retryReplyEmail(runtime, 'org', id, third.item.id)
  await assert.rejects(retryReplyEmail(runtime, 'org', id, third.item.id))
  await inboxTick(runtime); assert.equal(emails.length, 5)
  assert.equal(emails[2]!.idempotencyKey, emails[4]!.idempotencyKey)
  await assert.rejects(retryReplyEmail(runtime, 'org', id, third.item.id))
})

test('stale leases are recovered and fresh leases are not stolen', async () => {
  await reset(); const id = await task('processing', -1)
  await inboxTick(runtime)
  assert.equal((await pool.query('SELECT status FROM scheduled_task WHERE id=$1',[id])).rows[0].status, 'processing')
  await pool.query("UPDATE scheduled_task SET updated_at=now()-interval '11 minutes' WHERE id=$1", [id])
  await inboxTick(runtime)
  assert.equal((await pool.query('SELECT status FROM scheduled_task WHERE id=$1',[id])).rows[0].status, 'done')
})


test('an earlier new task replaces a later wake immediately, without reposting equivalent rounded wakes', async () => {
  await reset(); await task('pending', 3600)
  await scheduleInbox(runtime, transport)
  await scheduleInbox(runtime, transport)
  assert.equal(deliveries.length, 1)
  await task('pending', 60)
  await scheduleInbox(runtime, transport)
  assert.equal(deliveries.length, 2)
  assert.ok(deliveries[1]!.seconds < deliveries[0]!.seconds)
  await scheduleInbox(runtime, transport)
  assert.equal(deliveries.length, 2)
})

test('an HTTP schedule does not cancel or repost a wake that is already waiting', async () => {
  await reset(); await task('pending', 3600)
  await scheduleInbox(runtime, transport, 'external')
  assert.equal(deliveries.length, 1)
  await task('pending', 60)
  await scheduleInbox(runtime, transport, 'external')
  assert.equal(deliveries.length, 1)
  await scheduleInbox(runtime, transport)
  assert.equal(deliveries.length, 2)
})

test('late wakes are reused, stalled wakes recover once, and cancelled deliveries cannot renew', async () => {
  await reset(); await task('pending', -60)
  await scheduleInbox(runtime, transport, 'external')
  const original = deliveries[0]!.message
  for (const access of ['external', 'internal', 'external'] as const) await scheduleInbox(runtime, transport, access)
  assert.equal(deliveries.length, 1)
  await pool.query("UPDATE delay_message SET expect_at=now()-interval '11 minutes',sent_at=now()-interval '11 minutes'")
  // Keep the old delivery's generation aligned with the simulated send time.
  original.sentAt = new Date((await pool.query('SELECT sent_at FROM delay_message')).rows[0].sent_at).toISOString()
  await scheduleInbox(runtime, transport, 'external')
  await scheduleInbox(runtime, transport, 'external')
  await scheduleInbox(runtime, transport)
  assert.equal(deliveries.length, 2)
  assert.equal((await pool.query('SELECT status FROM delay_message WHERE id=$1', [original.id])).rows[0].status, 'cancelled')
  await consumeInbox(runtime, transport, original)
  assert.equal(deliveries.length, 2)
  assert.equal((await pool.query('SELECT status FROM scheduled_task')).rows[0].status, 'done')
  await consumeInbox(runtime, transport, deliveries[1]!.message)
  assert.equal((await pool.query('SELECT status FROM delay_message WHERE id=$1', [deliveries[1]!.message.id])).rows[0].status, 'fired')
})

test('invalid future email status cannot make a reply send early; missing email does not retry forever', async () => {
  await reset(); const id = await conversation(); const saved = await reply(id, 'Future reply')
  await pool.query("UPDATE scheduled_task SET status='unexpected' WHERE item_id=$1", [saved.item.id])
  await inboxTick(runtime); assert.equal(emails.length, 0)
  await pool.query("UPDATE scheduled_task SET schedule_at=now()-interval '1 second' WHERE item_id=$1", [saved.item.id])
  await pool.query("UPDATE \"user\" SET is_anonymous=true WHERE id='customer'")
  try {
    await inboxTick(runtime)
    assert.equal(emails.length, 0)
    assert.equal((await pool.query('SELECT result FROM scheduled_task WHERE item_id=$1', [saved.item.id])).rows[0].result, 'unavailable')
  } finally { await pool.query("UPDATE \"user\" SET is_anonymous=false WHERE id='customer'") }
})

test('a callback arriving before the wake transaction commits retries instead of losing the task', async () => {
  await reset(); await task('pending', -1)
  const early: DelayTransport = { ...transport, async send(message, seconds) {
    await assert.rejects(consumeInbox(runtime, transport, message), /not committed/)
    deliveries.push({ message, seconds })
  } }
  assert.equal((await scheduleInbox(runtime, early)).scheduled, true)
  await consumeInbox(runtime, transport, deliveries[0]!.message)
  assert.equal((await pool.query('SELECT status FROM scheduled_task')).rows[0].status, 'done')
  assert.equal((await pool.query('SELECT status FROM delay_message')).rows[0].status, 'fired')
})

test('immediate email sends even after reading, while automatic replies wait and skip read messages', async () => {
  await reset()
  const id = await conversation()
  const automatic = await reply(id, 'Automatic reply')
  const command = {
    action: 'reply' as const, requestId: uuidv7(), expectedLastSeq: automatic.item.seq,
    notifyByEmail: true, content: { parts: [{ type: 'text' as const, text: 'Immediate reply' }] },
  }
  const immediate = await staffCommand(runtime, id, 'org', 'staff', command)
  assert.equal((await staffCommand(runtime, id, 'org', 'staff', command)).replayed, true)
  await assert.rejects(staffCommand(runtime, id, 'org', 'staff', { ...command, notifyByEmail: false }))
  const { rows: tasks } = await pool.query("SELECT delivery_mode,schedule_at<=clock_timestamp() AS due FROM scheduled_task WHERE kind='inbox_email' ORDER BY schedule_at")
  assert.deepEqual(tasks, [{ delivery_mode: 'immediate', due: true }, { delivery_mode: 'auto', due: false }])
  await markCustomerRead(runtime, id, 'org', 'customer', 14, immediate.item.seq)
  assert.equal((await deliverReplyNow(runtime, 'org', id, immediate.item.id))?.status, 'accepted')
  assert.equal(emails.length, 1)
  assert.match(emails[0]!.text!, /Immediate reply/)
  await pool.query("UPDATE scheduled_task SET schedule_at=now()-interval '1 second' WHERE kind='inbox_email'")
  await inboxTick(runtime)
  await inboxTick(runtime)
  assert.equal(emails.length, 1)
  const detail = await readInbox(runtime, 'org', id, pageInput.parse({}))
  assert.equal(detail.emails[immediate.item.id].deliveryMode, 'immediate')
  assert.equal(detail.emails[immediate.item.id].status, 'accepted')
  assert.equal(detail.emails[automatic.item.id].status, 'skipped')
})

test('immediate delivery keeps its policy through automatic and manual retries', async () => {
  await reset()
  const id = await conversation()
  const result = await staffCommand(runtime, id, 'org', 'staff', {
    action: 'reply', requestId: uuidv7(), expectedLastSeq: 1, notifyByEmail: true,
    content: { parts: [{ type: 'text', text: 'Immediate retry test' }] },
  })
  await markCustomerRead(runtime, id, 'org', 'customer', 14, result.item.seq)
  failEmail = true
  assert.equal((await deliverReplyNow(runtime, 'org', id, result.item.id))?.status, 'failed')
  assert.equal(emails.length, 2)
  failEmail = false
  const retry = await retryReplyEmail(runtime, 'org', id, result.item.id)
  assert.equal(retry.deliveryMode, 'immediate')
  assert.equal((await deliverReplyNow(runtime, 'org', id, result.item.id))?.status, 'accepted')
  assert.equal(emails.length, 3)
  assert.equal(emails[0]!.idempotencyKey, emails[2]!.idempotencyKey)
  await assert.rejects(retryReplyEmail(runtime, 'org', id, result.item.id))
})


test('anonymous and empty-email customers do not queue either reply email mode', async () => {
  await reset()
  try {
    for (const recipient of [{ anonymous: true, email: 'placeholder@example.com' }, { anonymous: false, email: '   ' }]) {
      await pool.query("UPDATE \"user\" SET is_anonymous=$1,email=$2 WHERE id='customer'", [recipient.anonymous, recipient.email])
      const id = await conversation()
      for (const notifyByEmail of [false, true]) {
        const { rows: [row] } = await pool.query('SELECT last_seq FROM conversation WHERE id=$1', [id])
        const saved = await staffCommand(runtime, id, 'org', 'staff', {
          action: 'reply', requestId: uuidv7(), expectedLastSeq: Number(row.last_seq), notifyByEmail,
          content: { parts: [{ type: 'text', text: 'Reply without a deliverable email' }] },
        })
        assert.ok(saved.item.id)
        assert.equal((await pool.query("SELECT count(*)::int AS count FROM scheduled_task WHERE kind='inbox_email' AND item_id=$1", [saved.item.id])).rows[0].count, 0)
      }
    }
    assert.equal(emails.length, 0)
  } finally {
    await pool.query("UPDATE \"user\" SET is_anonymous=false,email='customer@example.com' WHERE id='customer'")
  }
})


test('a named customer with a reserved .invalid address records the reply email as unavailable', async () => {
  await reset()
  try {
    await pool.query("UPDATE \"user\" SET is_anonymous=false,email='emma.chen-abcd1234@sample.invalid' WHERE id='customer'")
    const id = await conversation()
    const { rows: [row] } = await pool.query('SELECT last_seq FROM conversation WHERE id=$1', [id])
    const saved = await staffCommand(runtime, id, 'org', 'staff', {
      action: 'reply', requestId: uuidv7(), expectedLastSeq: Number(row.last_seq), notifyByEmail: true,
      content: { parts: [{ type: 'text', text: 'Reply to a sample customer' }] },
    })
    assert.equal((await deliverReplyNow(runtime, 'org', id, saved.item.id))?.status, 'unavailable')
    assert.equal(emails.length, 0)
  } finally {
    await pool.query("UPDATE \"user\" SET is_anonymous=false,email='customer@example.com' WHERE id='customer'")
  }
})

test('reply deadlines remain 48 hours even with a stale test environment flag', async () => {
  await reset()
  const previous = process.env.NUXT_PUBLIC_INBOX_TEST_SHORT_TIMERS
  try {
    for (const enabled of [true, false]) {
      process.env.NUXT_PUBLIC_INBOX_TEST_SHORT_TIMERS = String(enabled)
      const saved = await reply(await conversation(), 'Check closing deadline')
      assert.equal(+new Date(saved.conversation.stateDueAt!) - +new Date(saved.item.createdAt), 48 * 3600000)
    }
  } finally {
    if (previous === undefined) delete process.env.NUXT_PUBLIC_INBOX_TEST_SHORT_TIMERS
    else process.env.NUXT_PUBLIC_INBOX_TEST_SHORT_TIMERS = previous
  }
})


test('Node wake resolution preserves five-minute deadlines without queue rounding', async () => {
  await reset()
  const now = new Date('2026-09-29T10:02:30.123Z')
  const due = new Date(+now + 5 * 60000)
  assert.equal(+wakeAt(due, now, 23 * 3600, 1000) - +due, 877)
  assert.equal(wakeAt(due, now, 23 * 3600).toISOString(), '2026-09-29T10:10:00.000Z')
  await task('pending', 300)
  await scheduleInbox(runtime, { ...transport, wakeResolutionMs: 1000 })
  assert.equal(deliveries.length, 1)
  assert.ok(deliveries[0]!.seconds >= 299 && deliveries[0]!.seconds <= 301)
})


test('direct delivery sends without a scheduler, respects tenancy and does not duplicate with recovery', async () => {
  await reset()
  const id = await conversation()
  const automatic = await reply(id, 'Still waits five minutes')
  assert.equal((await deliverReplyNow(runtime, 'org', id, automatic.item.id))?.status, 'pending')
  const saved = await staffCommand(runtime, id, 'org', 'staff', {
    action: 'reply', requestId: uuidv7(), expectedLastSeq: automatic.item.seq, notifyByEmail: true,
    content: { parts: [{ type: 'text', text: 'Direct delivery' }] },
  })
  assert.equal(await deliverReplyNow(runtime, 'other-org', id, saved.item.id), null)
  assert.equal(emails.length, 0)
  await Promise.all([
    deliverReplyNow(runtime, 'org', id, saved.item.id),
    deliverReplyNow(runtime, 'org', id, saved.item.id),
  ])
  assert.equal(emails.length, 1)
  await inboxTick(runtime)
  assert.equal((await deliverReplyNow(runtime, 'org', id, saved.item.id))?.status, 'accepted')
  assert.equal(emails.length, 1)
})

test('reply email uses preceding customer source and never copies the conversation title into its subject', async () => {
  await reset()
  const id = await conversation()
  await pool.query("UPDATE conversation SET title='Private order SYNTHETIC-123 customer@example.com' WHERE id=$1", [id])
  await pool.query(`INSERT INTO conversation_item(id,conversation_id,seq,author_type,author_user_id,content,context)
    VALUES($1,$2,1,'customer','customer',$3,$4)`, [uuidv7(), id, JSON.stringify({parts:[{type:'text',text:'Help with a refund'}]}), JSON.stringify({origin:'https://product.example',pathname:'/support'})])
  const saved = await staffCommand(runtime, id, 'org', 'staff', {
    action: 'reply', requestId: uuidv7(), expectedLastSeq: 1, notifyByEmail: true,
    content: { parts: [{ type: 'text', text: 'Here is our reply' }] },
  })
  await pool.query(`INSERT INTO conversation_item(id,conversation_id,seq,author_type,author_user_id,content,context)
    VALUES($1,$2,3,'customer','customer',$3,$4)`, [uuidv7(), id, JSON.stringify({parts:[{type:'text',text:'Later question'}]}), JSON.stringify({origin:'https://later.example',pathname:'/other'})])
  await deliverReplyNow(runtime, 'org', id, saved.item.id)
  assert.equal(emails.length, 1)
  assert.match(emails[0]!.html, /https:\/\/product.example\/support/)
  assert.doesNotMatch(emails[0]!.html, /later.example/)
  assert.doesNotMatch(emails[0]!.subject, /SYNTHETIC|customer@example|Private order/)
})

test('Help indexing reuses the existing delayed delivery and reschedules only pending retries', async () => {
  await reset()
  const enabled = process.env.HELP_VECTOR_SEARCH, key = process.env.OPENAI_API_KEY, originalFetch = globalThis.fetch
  const articleId = uuidv7(), collectionId = uuidv7()
  let calls = 0
  try {
    process.env.HELP_VECTOR_SEARCH = 'true'
    process.env.OPENAI_API_KEY = 'local-test-only'
    globalThis.fetch = async (_url, init) => {
      calls++
      if (calls === 1) return new Response('{}', { status: 429 })
      const input = JSON.parse(String(init?.body)).input as string[]
      return Response.json({ data: input.map((_, index) => ({ index, embedding: [1, ...Array(767).fill(0)] })) })
    }
    await pool.query("INSERT INTO help_collection(id,org_id,name,icon,position) VALUES($1,'org','Help scheduler','book-open',0)", [collectionId])
    await pool.query(`INSERT INTO help_article(id,org_id,collection_id,short_id,slug,title,content,tsv,position)
      VALUES($1,'org',$2,'wake01','wake','Help wake','Retry this article',''::tsvector,0)`, [articleId, collectionId])
    await queueHelpIndex(drizzlePg(pool), articleId)
    assert.equal((await scheduleInbox(runtime, transport)).scheduled, true)
    assert.equal(deliveries.length, 1)
    await consumeInbox(runtime, transport, deliveries[0]!.message)
    const job = (await pool.query("SELECT status,result,attempts FROM scheduled_task WHERE kind='help_index' AND ref_id=$1", [articleId])).rows[0]
    assert.equal(job.status, 'pending')
    assert.equal(job.result, 'provider_429')
    assert.equal(job.attempts, 1)
    const active = (await pool.query("SELECT id,sent_at,expect_at FROM delay_message WHERE status='scheduled'")).rows
    assert.equal(active.length, 1, 'only one wake covers the pending retry')
    assert.ok(+new Date(active[0].expect_at) > Date.now())
    assert.equal((await pool.query('SELECT status FROM delay_message WHERE id=$1', [deliveries[0]!.message.id])).rows[0].status, 'fired')
    const retryMessage = { id: active[0].id, sentAt: new Date(active[0].sent_at).toISOString() }
    // Advance the persisted due times, without waiting for the real backoff.
    await pool.query("UPDATE scheduled_task SET schedule_at=clock_timestamp() WHERE kind='help_index' AND ref_id=$1", [articleId])
    await pool.query('UPDATE delay_message SET expect_at=clock_timestamp() WHERE id=$1', [retryMessage.id])
    await consumeInbox(runtime, transport, retryMessage)
    assert.equal((await pool.query("SELECT status FROM scheduled_task WHERE kind='help_index' AND ref_id=$1", [articleId])).rows[0].status, 'done')
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM delay_message WHERE status='scheduled'")).rows[0].n, 0, 'recovery wakes are cancelled when all work finishes')
    const deliveryCount = deliveries.length
    await scheduleInbox(runtime, transport)
    assert.equal(deliveries.length, deliveryCount, 'no new wake when both Help and Inbox have no pending work')
    await consumeInbox(runtime, transport, retryMessage)
    assert.equal(calls, 2, 'duplicate deliveries do not embed again')
  } finally {
    globalThis.fetch = originalFetch
    if (enabled === undefined) delete process.env.HELP_VECTOR_SEARCH; else process.env.HELP_VECTOR_SEARCH = enabled
    if (key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = key
    await pool.query('DELETE FROM help_article WHERE id=$1', [articleId])
    await deleteHelpIndex(drizzlePg(pool), articleId)
    await pool.query('DELETE FROM help_collection WHERE id=$1', [collectionId])
  }
})

test('Help wake failure keeps work durable and disabling Help creates no deliveries', async () => {
  await reset()
  const enabled = process.env.HELP_VECTOR_SEARCH, articleId = uuidv7(), collectionId = uuidv7()
  try {
    await pool.query("INSERT INTO help_collection(id,org_id,name,icon,position) VALUES($1,'org','Recovery','book-open',0)", [collectionId])
    await pool.query(`INSERT INTO help_article(id,org_id,collection_id,short_id,slug,title,content,tsv,position)
      VALUES($1,'org',$2,'wake02','wake','Recovery','Durable work',''::tsvector,0)`, [articleId, collectionId])
    await queueHelpIndex(drizzlePg(pool), articleId)
    process.env.HELP_VECTOR_SEARCH = 'false'
    assert.equal((await scheduleInbox(runtime, transport)).scheduled, false)
    process.env.HELP_VECTOR_SEARCH = 'true'
    failQueue = new Error('Synthetic transport failure')
    assert.equal((await scheduleInbox(runtime, transport)).scheduled, false)
    assert.equal((await pool.query("SELECT status FROM scheduled_task WHERE kind='help_index' AND ref_id=$1", [articleId])).rows[0].status, 'pending')
    failQueue = undefined
    assert.equal((await scheduleInbox(runtime, transport, 'external')).scheduled, true)
    assert.equal(deliveries.length, 1)
  } finally {
    failQueue = undefined
    if (enabled === undefined) delete process.env.HELP_VECTOR_SEARCH; else process.env.HELP_VECTOR_SEARCH = enabled
    await pool.query('DELETE FROM help_article WHERE id=$1', [articleId])
    await deleteHelpIndex(drizzlePg(pool), articleId)
    await pool.query('DELETE FROM help_collection WHERE id=$1', [collectionId])
  }
})


async function within<T>(promise: Promise<T>, milliseconds = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Work was blocked by another delivery')), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}

test('a blocked Help provider holds no consumer lock and does not suppress a new Inbox wake', async () => {
  await reset()
  const enabled = process.env.HELP_VECTOR_SEARCH, key = process.env.OPENAI_API_KEY, originalFetch = globalThis.fetch
  const articleId = uuidv7(), collectionId = uuidv7()
  let release!: () => void, started!: () => void, calls = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const providerStarted = new Promise<void>(resolve => { started = resolve })
  let indexing: Promise<unknown> | undefined
  try {
    process.env.HELP_VECTOR_SEARCH = 'true'
    process.env.OPENAI_API_KEY = 'local-test-only'
    globalThis.fetch = async (_url, init) => {
      calls++; started(); await gate
      const input = JSON.parse(String(init?.body)).input as string[]
      return Response.json({ data: input.map((_, index) => ({ index, embedding: [1, ...Array(767).fill(0)] })) })
    }
    await pool.query("INSERT INTO help_collection(id,org_id,name,icon,position) VALUES($1,'org','Concurrent indexing','book-open',0)", [collectionId])
    await pool.query(`INSERT INTO help_article(id,org_id,collection_id,short_id,slug,title,content,tsv,position)
      VALUES($1,'org',$2,'lock01','lock','Concurrent indexing','Held provider',''::tsvector,0)`, [articleId, collectionId])
    await queueHelpIndex(drizzlePg(pool), articleId)
    await task('pending', 60)
    await scheduleInbox(runtime, transport)
    const original = deliveries[0]!.message
    indexing = consumeInbox(runtime, transport, original)
    await within(providerStarted)
    const recovery = (await pool.query("SELECT expect_at FROM delay_message WHERE status='scheduled'")).rows
    assert.equal(recovery.length, 1, 'a durable wake exists before waiting on the provider')
    assert.ok(+new Date(recovery[0].expect_at) > Date.now())
    await within(consumeInbox(runtime, transport, original))
    assert.equal(calls, 1, 'a duplicate delivery cannot claim the running article')

    const next = await task('pending', -1)
    assert.equal((await scheduleInbox(runtime, transport)).scheduled, true, 'new due work replaces the future recovery wake')
    await within(consumeInbox(runtime, transport, deliveries.at(-1)!.message))
    assert.equal((await pool.query('SELECT status FROM scheduled_task WHERE id=$1', [next])).rows[0].status, 'done')
    assert.equal((await pool.query("SELECT status FROM scheduled_task WHERE kind='help_index' AND ref_id=$1", [articleId])).rows[0].status, 'processing')
    assert.equal(calls, 1)
    release(); await indexing
    assert.equal((await pool.query("SELECT status FROM scheduled_task WHERE kind='help_index' AND ref_id=$1", [articleId])).rows[0].status, 'done')
  } finally {
    release(); await indexing?.catch(() => {})
    globalThis.fetch = originalFetch
    if (enabled === undefined) delete process.env.HELP_VECTOR_SEARCH; else process.env.HELP_VECTOR_SEARCH = enabled
    if (key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = key
    await pool.query('DELETE FROM help_article WHERE id=$1', [articleId])
    await deleteHelpIndex(drizzlePg(pool), articleId)
    await pool.query('DELETE FROM help_collection WHERE id=$1', [collectionId])
  }
})

test('separate deliveries index different articles concurrently using per-article leases', async () => {
  await reset()
  const enabled = process.env.HELP_VECTOR_SEARCH, key = process.env.OPENAI_API_KEY, originalFetch = globalThis.fetch
  const collectionId = uuidv7(), articles = [uuidv7(), uuidv7()]
  let release!: () => void, firstStarted!: () => void, secondStarted!: () => void, calls = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const first = new Promise<void>(resolve => { firstStarted = resolve })
  const second = new Promise<void>(resolve => { secondStarted = resolve })
  const running: Promise<unknown>[] = []
  try {
    process.env.HELP_VECTOR_SEARCH = 'true'
    process.env.OPENAI_API_KEY = 'local-test-only'
    globalThis.fetch = async (_url, init) => {
      calls++; if (calls === 1) firstStarted(); else secondStarted()
      await gate
      const input = JSON.parse(String(init?.body)).input as string[]
      return Response.json({ data: input.map((_, index) => ({ index, embedding: [1, ...Array(767).fill(0)] })) })
    }
    await pool.query("INSERT INTO help_collection(id,org_id,name,icon,position) VALUES($1,'org','Parallel articles','book-open',0)", [collectionId])
    for (const [i, id] of articles.entries()) {
      await pool.query(`INSERT INTO help_article(id,org_id,collection_id,short_id,slug,title,content,tsv,position)
        VALUES($1,'org',$2,$3,$3,'Parallel article','Article body',''::tsvector,0)`, [id, collectionId, `para0${i}`])
      await queueHelpIndex(drizzlePg(pool), id)
    }
    await scheduleInbox(runtime, transport)
    running.push(consumeInbox(runtime, transport, deliveries[0]!.message))
    await within(first)
    const { rows: [wake] } = await pool.query("SELECT id,sent_at FROM delay_message WHERE status='scheduled'")
    assert.ok(wake, 'the next article has a wake before the first finishes')
    running.push(consumeInbox(runtime, transport, { id: wake.id, sentAt: new Date(wake.sent_at).toISOString() }))
    await within(second)
    const jobs = (await pool.query("SELECT status,attempts FROM scheduled_task WHERE kind='help_index' AND ref_id=ANY($1::uuid[])", [articles])).rows
    assert.deepEqual(jobs, [{ status: 'processing', attempts: 1 }, { status: 'processing', attempts: 1 }])
    release(); await Promise.all(running)
    assert.equal(calls, 2)
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM scheduled_task WHERE kind='help_index' AND ref_id=ANY($1::uuid[]) AND status='done' AND result='indexed'", [articles])).rows[0].n, 2)
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM delay_message WHERE status='scheduled'")).rows[0].n, 0)
  } finally {
    release(); await Promise.allSettled(running)
    globalThis.fetch = originalFetch
    if (enabled === undefined) delete process.env.HELP_VECTOR_SEARCH; else process.env.HELP_VECTOR_SEARCH = enabled
    if (key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = key
    await pool.query('DELETE FROM help_article WHERE id=ANY($1::uuid[])', [articles])
    for (const id of articles) await deleteHelpIndex(drizzlePg(pool), id)
    await pool.query('DELETE FROM help_collection WHERE id=$1', [collectionId])
  }
})
