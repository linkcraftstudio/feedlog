import { createEvent, getQuery, getRouterParam } from 'h3'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readConversationItems } from '../server/lib/agent/history'
import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { uuidv7 } from 'uuidv7'
import { agentRuntime, transaction, appendItem, type Actor } from '../server/lib/agent/runtime'
import { startRun, renewRun, failRun, completeRun, readStoppedRun } from '../server/lib/agent/conversations'
import { handoff, staffCommand } from '../server/lib/inbox/service'
import { syncConversationTask, syncRunTask } from '../server/lib/inbox/tasks'
import { inboxTick } from '../server/lib/inbox/tick'
import { runScheduledInbox } from '../server/lib/inbox/scheduler'
import { chatInput } from '../shared/agent/content'
import type { H3Event } from 'h3'
import { registerEmailProvider } from '../server/utils/email'
import { sendInboxEmail } from '../server/lib/inbox/email'
import { listConversations, readInbox } from '../server/lib/inbox/queries'
import { listInput, pageInput } from '../shared/inbox/schemas'
import { assertConversationImage } from '../server/lib/inbox/attachments'

assert.match(process.env.DATABASE_URL ?? '', /@(?:localhost|127\.0\.0\.1):\d+\/feedlog_inbox_mvp$/)
const runtime = agentRuntime({ context: {} } as H3Event)
const emitted: import('../server/lib/inbox/events').InboxEvent[] = []
runtime.publishInboxEvent = (event) => {
  emitted.push(event)
}
const { pool } = runtime
after(() => runtime.close())
const send = () =>
  chatInput.parse({
    action: 'send',
    idempotency_key: uuidv7(),
    message: { id: uuidv7(), content: { parts: [{ type: 'text', text: 'Please help' }] } },
  })
const errorCode = (code: string) => (error: unknown) => (error as { data?: { code: string } }).data?.code === code
async function fixture(firstAnswerDeadline?: number) {
  const orgId = `inbox-${uuidv7()}`,
    userId = `customer-${uuidv7()}`,
    staffId = `staff-${uuidv7()}`,
    id = uuidv7()
  await pool.query('INSERT INTO organization (id,name,slug) VALUES ($1,$1,$1)', [orgId])
  for (const uid of [userId, staffId])
    await pool.query('INSERT INTO "user" (id,name,email) VALUES ($1,$1,$2)', [uid, `${uid}@example.com`])
  await pool.query("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES ($1,$2,$1,'manager',now())", [staffId, orgId])
  const actor = { orgId, customerId: userId, retentionDays: 14 } as Actor
  const first = await startRun(runtime, id, actor, send(), firstAnswerDeadline)
  const row = async () => (await pool.query('SELECT * FROM conversation WHERE id=$1', [id])).rows[0]
  const action = async (value: 'close' | 'resume' | 'takeover') =>
    staffCommand(runtime, id, orgId, staffId, {
      action: value,
      requestId: uuidv7(),
      expectedLastSeq: Number((await row()).last_seq),
    })
  const reply = async () =>
    staffCommand(runtime, id, orgId, staffId, {
      action: 'reply',
      requestId: uuidv7(),
      expectedLastSeq: Number((await row()).last_seq),
      content: { parts: [{ type: 'text', text: 'Staff answer' }] },
      notifyByEmail: false,
    })
  const clean = async () => {
    await pool.query('DELETE FROM scheduled_task WHERE ref_id=$1 OR ref_id IN (SELECT id FROM agent_run WHERE conversation_id=$1)', [id])
    await pool.query('DELETE FROM post WHERE org_id=$1', [orgId])
    await pool.query("DELETE FROM conversation_item WHERE conversation_id=$1 AND author_type='agent'", [id])
    await pool.query('DELETE FROM agent_run WHERE conversation_id=$1', [id])
    await pool.query('DELETE FROM conversation_item WHERE conversation_id=$1', [id])
    await pool.query('DELETE FROM conversation WHERE org_id=$1', [orgId])
    await pool.query('DELETE FROM organization WHERE id=$1', [orgId])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [[userId, staffId]])
  }
  return { id, orgId, staffId, actor, first, row, action, reply, clean }
}

test('manual takeover waits for the complete AI reply and persists the shared inbox workflow', async () => {
  const f = await fixture()
  try {
    await pool.query("UPDATE conversation SET priority=1,state_due_at=now()+interval '48 hours' WHERE id=$1", [f.id])
    await transaction(runtime, client => syncConversationTask(client, f.id))
    const before = await f.row()
    const input = { action: 'takeover' as const, requestId: uuidv7(), expectedLastSeq: Number(before.last_seq) }
    const result = await staffCommand(runtime, f.id, f.orgId, f.staffId, input)
    assert.equal(result.conversation.status, 'ai_handling')
    assert.equal(result.conversation.takeoverPending, true)
    assert.equal(result.conversation.priority, 'high')
    assert.equal(+new Date(result.conversation.stateDueAt!), +before.state_due_at)
    const after = await f.row()
    assert.equal(+after.last_message_at, +before.last_message_at)
    assert.equal(after.preview_text, before.preview_text)
    const { rows: [item] } = await pool.query('SELECT * FROM conversation_item WHERE id=$1', [result.item.id])
    assert.equal(item.author_user_id, f.staffId)
    assert.deepEqual(item.content.parts, [{ type: 'system_event', kind: 'takeover_requested', reason: 'manual', fromStatus: 'ai_handling', toStatus: 'ai_handling', runId: f.first.run!.id }])
    assert.equal((await pool.query('SELECT status FROM agent_run WHERE id=$1', [f.first.run!.id])).rows[0].status, 'running')
    assert.equal(await renewRun(runtime, f.id, f.actor, f.first.run!.id, Date.now() + 120000), true)
    await assert.rejects(() => f.reply(), errorCode('state_conflict'))
    await assert.rejects(() => startRun(runtime, f.id, f.actor, send()), errorCode('conversation_busy'))
    assert.equal((await readInbox(runtime, f.orgId, f.id, pageInput.parse({}))).conversation.takeoverPending, true)
    assert.equal((await listConversations(runtime, f.orgId, listInput.parse({ status: 'ai_handling' }))).items[0]!.takeoverPending, true)
    const completed = await completeRun(runtime, f.id, f.actor, f.first.run!.id, uuidv7(), { parts: [{ type: 'text', text: 'A complete AI answer, including its final sentence.' }] })
    assert.ok(completed.takeover)
    assert.ok(completed.lastSeq < completed.takeover.seq)
    assert.equal((await f.row()).status, 'open')
    assert.equal((await f.row()).state_due_at, null)
    assert.equal((await pool.query('SELECT status FROM agent_run WHERE id=$1', [f.first.run!.id])).rows[0].status, 'completed')
    const tasks = (await pool.query('SELECT kind,status FROM scheduled_task WHERE ref_id=ANY($1::uuid[])', [[f.id, f.first.run!.id]])).rows
    assert.ok(tasks.every(task => task.status === 'cancelled'))
    assert.ok(!tasks.some(task => task.kind === 'inbox_handoff_email'))
    const replay = await staffCommand(runtime, f.id, f.orgId, f.staffId, input)
    assert.equal(replay.replayed, true)
    assert.equal(replay.conversation.takeoverPending, false)
    assert.equal(replay.conversation.status, 'open')
    const stopped = await readStoppedRun(runtime, f.id, f.orgId, f.first.run!.id)
    assert.equal(stopped?.notice_id, completed.takeover.id)
    assert.equal(stopped?.status, 'open')
    assert.equal(await readStoppedRun(runtime, f.id, 'other-organization', f.first.run!.id), null)
    const human = await startRun(runtime, f.id, f.actor, send())
    assert.equal(human.mode, 'human')
    assert.equal(human.run, null)
    assert.equal((await f.reply()).conversation.status, 'pending')
    await f.action('close')
    const reopened = await startRun(runtime, f.id, f.actor, send())
    assert.equal(reopened.mode, 'ai')
    assert.notEqual(reopened.run!.id, f.first.run!.id)
    assert.equal(await readStoppedRun(runtime, f.id, f.orgId, f.first.run!.id), null)
    assert.equal((await f.row()).status, 'ai_handling')
    assert.equal((await readInbox(runtime, f.orgId, f.id, pageInput.parse({}))).conversation.takeoverPending, false)
  } finally { await f.clean() }
})

test('manual takeover stays in staff history and is silent in full and incremental customer history', async () => {
  Object.assign(globalThis, { getQuery, getRouterParam })
  for (const active of [true, false]) {
    const f = await fixture()
    try {
      if (!active) await failRun(runtime, f.first.run!.id, 'synthetic_failure')
      await f.action('takeover')
      let replySeq = 1
      if (active) {
        const completed = await completeRun(runtime, f.id, f.actor, f.first.run!.id, uuidv7(), { parts: [{ type: 'text', text: 'The complete AI answer.' }] })
        replySeq = completed.lastSeq
      }
      const read = async (afterSeq?: number) => {
        const event = createEvent({ url: `/api/widget/conversations/${f.id}/items${afterSeq === undefined ? '' : `?afterSeq=${afterSeq}`}`, headers: { host: 'localhost' }, method: 'GET' } as IncomingMessage, {} as ServerResponse)
        event.context.params = { id: f.id }
        return readConversationItems(event, f.actor)
      }
      const staff = await readInbox(runtime, f.orgId, f.id, pageInput.parse({}))
      assert.ok(staff.items.some(item => item.content.parts.some(part => part.type === 'system_event' && part.kind === 'takeover')))
      const full = await read()
      assert.equal(full.conversation.handling, 'human')
      assert.equal(full.items.filter(item => item?.authorType === 'system').length, 0)
      assert.equal(full.items.filter(item => item?.authorType === 'agent').length, active ? 1 : 0)
      const incremental = await read(replySeq)
      assert.deepEqual(incremental.items, [])
      assert.equal(incremental.conversation.handling, 'human')
      assert.equal(incremental.nextAfterSeq, Number((await f.row()).last_seq))
      assert.ok(incremental.nextAfterSeq > replySeq, 'hidden events still advance the history cursor')
      await f.reply()
      assert.equal((await read()).items.at(-1)?.authorType, 'staff')
    } finally { await f.clean() }
  }
})

test('takeover works without a running AI and rejects stale, foreign and human-state commands', async () => {
  const f = await fixture()
  try {
    const input = { action: 'takeover' as const, requestId: uuidv7(), expectedLastSeq: Number((await f.row()).last_seq) }
    await assert.rejects(() => staffCommand(runtime, f.id, 'other-organization', f.staffId, input), errorCode('conversation_not_found'))
    await assert.rejects(() => staffCommand(runtime, f.id, f.orgId, f.staffId, { ...input, expectedLastSeq: 0 }), errorCode('revision_conflict'))
    await failRun(runtime, f.first.run!.id, 'synthetic_failure')
    assert.equal((await f.action('takeover')).conversation.status, 'open')
    await assert.rejects(() => f.action('takeover'), errorCode('state_conflict'))
    await f.reply()
    await assert.rejects(() => f.action('takeover'), errorCode('state_conflict'))
    await staffCommand(runtime, f.id, f.orgId, f.staffId, { action: 'snooze', requestId: uuidv7(), expectedLastSeq: Number((await f.row()).last_seq), wakeAt: new Date(Date.now() + 3600000).toISOString(), timeZone: 'UTC' })
    await assert.rejects(() => f.action('takeover'), errorCode('state_conflict'))
    await f.action('close')
    await assert.rejects(() => f.action('takeover'), errorCode('state_conflict'))
    const reopened = await startRun(runtime, f.id, f.actor, send())
    await pool.query("UPDATE agent_run SET status='completed',finished_at=clock_timestamp() WHERE id=$1", [reopened.run!.id])
    assert.equal((await f.action('takeover')).conversation.status, 'open')
  } finally { await f.clean() }
})

test('concurrent takeover commands use existing revision checks without assigning an owner', async () => {
  const f = await fixture()
  try {
    const expectedLastSeq = Number((await f.row()).last_seq)
    const results = await Promise.allSettled(Array.from({ length: 2 }, () => staffCommand(runtime, f.id, f.orgId, f.staffId, { action: 'takeover', requestId: uuidv7(), expectedLastSeq })))
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    assert.ok(errorCode('revision_conflict')(rejected.reason))
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM conversation_item WHERE conversation_id=$1 AND content->'parts' @> '[{\"type\":\"system_event\",\"kind\":\"takeover_requested\"}]'::jsonb", [f.id])).rows[0].n, 1)
  } finally { await f.clean() }
})

test('AI failure or scheduled timeout completes a pending takeover exactly once', async () => {
  for (const timeout of [false, true]) {
    const f = await fixture()
    try {
      await f.action('takeover')
      if (timeout) {
        await pool.query("UPDATE agent_run SET started_at=clock_timestamp()-interval '2 minutes',deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.first.run!.id])
        await transaction(runtime, client => syncRunTask(client, f.first.run!.id))
        assert.equal((await inboxTick(runtime)).recoveredRuns, 1)
      } else assert.ok(await failRun(runtime, f.first.run!.id, 'synthetic_failure'))
      assert.equal((await f.row()).status, 'open')
      assert.equal((await f.row()).state_due_at, null)
      assert.equal(await failRun(runtime, f.first.run!.id, 'late_failure'), null)
      const detail = await readInbox(runtime, f.orgId, f.id, pageInput.parse({}))
      assert.equal(detail.conversation.takeoverPending, false)
      assert.equal(detail.items.filter(item => item.content.parts.some((part: { kind?: string }) => part.kind === 'takeover')).length, 1)
    } finally { await f.clean() }
  }
})

test('closing a pending takeover invalidates it without affecting the next AI round', async () => {
  const f = await fixture()
  try {
    await f.action('takeover')
    await f.action('close')
    assert.equal(await failRun(runtime, f.first.run!.id, 'late_failure'), null)
    await assert.rejects(() => completeRun(runtime, f.id, f.actor, f.first.run!.id, uuidv7(), { parts: [{ type: 'text', text: 'Old answer' }] }), /Run no longer active/)
    const reopened = await startRun(runtime, f.id, f.actor, send())
    assert.equal(reopened.mode, 'ai')
    assert.equal(await failRun(runtime, f.first.run!.id, 'late_failure'), null)
    assert.equal((await f.row()).status, 'ai_handling')
    assert.equal((await readInbox(runtime, f.orgId, f.id, pageInput.parse({}))).conversation.takeoverPending, false)
    assert.equal((await completeRun(runtime, f.id, f.actor, reopened.run!.id, uuidv7(), { parts: [{ type: 'text', text: 'New answer' }] })).takeover, null)
  } finally { await f.clean() }
})

test('an automatic AI handoff satisfies a waiting takeover without a second human transition', async () => {
  const f = await fixture()
  try {
    await f.action('takeover')
    await handoff(runtime, f.id, f.orgId, f.first.run!.id, 'user_requested')
    assert.equal((await f.row()).status, 'open')
    assert.equal(await failRun(runtime, f.first.run!.id, 'late_failure'), null)
    assert.equal((await readInbox(runtime, f.orgId, f.id, pageInput.parse({}))).conversation.takeoverPending, false)
  } finally { await f.clean() }
})

test('handoff stops AI; pending and snooze resume human; every closure starts a new AI round', async () => {
  const f = await fixture()
  try {
    await handoff(runtime, f.id, f.orgId, f.first.run!.id, 'user_requested')
    assert.equal((await f.row()).status, 'open')
    assert.equal(
      (await pool.query('SELECT status FROM agent_run WHERE id=$1', [f.first.run!.id])).rows[0].status,
      'cancelled',
    )
    const response = await f.reply()
    assert.equal(response.conversation.status, 'pending')
    assert.equal(+new Date(response.conversation.stateDueAt!) - +new Date(response.item.createdAt), 48 * 3600000)
    assert.equal((await startRun(runtime, f.id, f.actor, send())).mode, 'human')
    assert.equal((await f.row()).state_due_at, null)
    const snoozed = await staffCommand(runtime, f.id, f.orgId, f.staffId, {
      action: 'snooze',
      requestId: uuidv7(),
      expectedLastSeq: Number((await f.row()).last_seq),
      wakeAt: new Date(Date.now() + 3600000).toISOString(),
      timeZone: 'Asia/Shanghai',
    })
    assert.equal(snoozed.conversation.status, 'snoozed')
    assert.equal((await startRun(runtime, f.id, f.actor, send())).mode, 'human')
    for (const state of ['open', 'pending', 'snoozed', 'ai_handling']) {
      await pool.query(
        "UPDATE conversation SET status=$2,state_due_at=CASE WHEN $2 IN ('pending','snoozed') THEN now()+interval '1 hour' ELSE NULL END WHERE id=$1",
        [f.id, state],
      )
      await f.action('close')
      const reopened = await startRun(runtime, f.id, f.actor, send())
      assert.equal(reopened.mode, 'ai')
      assert.ok(reopened.run)
      assert.equal((await f.row()).priority, 0)
      await handoff(runtime, f.id, f.orgId, reopened.run.id, 'knowledge_gap')
    }
  } finally {
    await f.clean()
  }
})

test('duplicate commands across connections execute once and old close cannot close a reopened round', async () => {
  const f = await fixture()
  try {
    const input = { action: 'close' as const, requestId: uuidv7(), expectedLastSeq: Number((await f.row()).last_seq) }
    const results = await Promise.all([0, 1].map(() => staffCommand(runtime, f.id, f.orgId, f.staffId, input)))
    assert.equal(results.filter((r) => r.replayed).length, 1)
    const fresh = send()
    const reopened = await startRun(runtime, f.id, f.actor, fresh)
    const replay = await staffCommand(runtime, f.id, f.orgId, f.staffId, input)
    assert.equal(replay.conversation.status, 'ai_handling')
    assert.equal((await startRun(runtime, f.id, f.actor, fresh)).duplicate, true)
    assert.equal(
      (
        await pool.query("SELECT count(*)::int AS n FROM agent_run WHERE conversation_id=$1 AND status='running'", [
          f.id,
        ])
      ).rows[0].n,
      1,
    )
    await assert.rejects(
      () => staffCommand(runtime, f.id, f.orgId, f.staffId, { ...input, action: 'set_priority', priority: 'high' }),
      errorCode('idempotency_conflict'),
    )
    assert.equal(await handoff(runtime, f.id, f.orgId, f.first.run!.id, 'user_requested'), null)
    assert.notEqual(reopened.run!.id, f.first.run!.id)
  } finally {
    await f.clean()
  }
})

test('real scheduler closes AI/pending, wakes snoozed, recovers abandoned runs and is repeatable', async () => {
  const f = await fixture()
  try {
    await pool.query(
      "UPDATE agent_run SET started_at=now()-interval '3 minutes',deadline_at=now()-interval '1 minute' WHERE id=$1",
      [f.first.run!.id],
    )
    await transaction(runtime, client => syncRunTask(client, f.first.run!.id))
    assert.equal((await inboxTick(runtime)).recoveredRuns, 1)
    assert.equal((await f.row()).status, 'ai_handling')
    assert.equal((await pool.query('SELECT error FROM agent_run WHERE id=$1', [f.first.run!.id])).rows[0].error, 'ai_timeout')
    for (const state of ['pending', 'snoozed', 'ai_handling']) {
      await pool.query("UPDATE conversation SET status=$2,state_due_at=now()-interval '1 second' WHERE id=$1", [
        f.id,
        state,
      ])
      await transaction(runtime, client => syncConversationTask(client, f.id))
      const before = Number((await f.row()).last_seq)
      await Promise.all([inboxTick(runtime), inboxTick(runtime)])
      const row = await f.row()
      assert.equal(row.status, state === 'snoozed' ? 'open' : 'closed')
      assert.equal(Number(row.last_seq), before + 1)
      assert.equal(row.state_due_at, null)
    }
  } finally {
    await f.clean()
  }
})

test('scheduled runtime fails stalled runs without handoff and releases connections', async () => {
  const f = await fixture()
  const events: import('../server/lib/inbox/events').InboxEvent[] = []
  try {
    await pool.query("UPDATE agent_run SET started_at=now()-interval '3 minutes',deadline_at=now()-interval '1 minute' WHERE id=$1", [f.first.run!.id])
    await transaction(runtime, client => syncRunTask(client, f.first.run!.id))
    await runScheduledInbox({ cloudflare: { env: { POSTGRES: { connectionString: process.env.DATABASE_URL! } } } }, event => events.push(event))
    assert.equal((await f.row()).status, 'ai_handling')
    assert.equal(events.some(event => event.name === 'inbox.handoff'), false)
    await pool.query("UPDATE conversation SET status='pending',state_due_at=now()-interval '1 second' WHERE id=$1", [f.id])
    await transaction(runtime, client => syncConversationTask(client, f.id))
    await runScheduledInbox()
    assert.equal((await f.row()).status, 'closed')
    const { rows: [active] } = await pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='feedlog-inbox-task'")
    assert.equal(active.count, 0)
    // Workers must not fall back to a Node DATABASE_URL when a binding is missing.
    await assert.rejects(runScheduledInbox({ cloudflare: { env: {} } }), /database is not configured/)
  } finally {
    await f.clean()
  }
})

test('reply rollback, revision conflicts and priority preserve the waiting deadline', async () => {
  const f = await fixture()
  try {
    await handoff(runtime, f.id, f.orgId, f.first.run!.id, 'knowledge_gap')
    const before = await f.reply()
    const priority = await staffCommand(runtime, f.id, f.orgId, f.staffId, {
      action: 'set_priority',
      priority: 'high',
      requestId: uuidv7(),
      expectedLastSeq: before.conversation.lastSeq,
    })
    assert.equal(+new Date(priority.conversation.stateDueAt!), +new Date(before.conversation.stateDueAt!))
    await assert.rejects(
      () =>
        staffCommand(runtime, f.id, f.orgId, f.staffId, {
          action: 'close',
          requestId: uuidv7(),
          expectedLastSeq: before.conversation.lastSeq,
        }),
      errorCode('revision_conflict'),
    )
    await assert.rejects(() =>
      transaction(runtime, async (client) => {
        await appendItem(client, {
          id: uuidv7(),
          conversationId: f.id,
          author: 'staff',
          userId: 'nonexistent-staff',
          content: { parts: [{ type: 'text', text: 'Must roll back' }] },
        })
      }),
    )
    assert.equal(Number((await f.row()).last_seq), priority.conversation.lastSeq)
  } finally {
    await f.clean()
  }
})

test('email delivery attempts once without changing the stored reply or deadline', async () => {
  const f = await fixture()
  let attempts = 0
  const oldProvider = process.env.EMAIL_PROVIDER
  process.env.EMAIL_PROVIDER = 'inbox-test'
  registerEmailProvider({
    name: 'inbox-test',
    send: async () => {
      attempts++
      throw new Error('Synthetic provider failure')
    },
  })
  try {
    await handoff(runtime, f.id, f.orgId, f.first.run!.id, 'knowledge_gap')
    const reply = await f.reply()
    const before = await f.row()
    assert.deepEqual(await sendInboxEmail(runtime, f.orgId, f.id, reply.item.id), { status: 'failed' })
    assert.equal(attempts, 1)
    assert.deepEqual(await f.row(), before)
    const detail = await readInbox(runtime, f.orgId, f.id, pageInput.parse({}))
    assert.equal(JSON.stringify(detail).includes('request_hash'), false)
    assert.equal(detail.items.filter((item) => item.authorType === 'staff').length, 1)
  } finally {
    if (oldProvider === undefined) delete process.env.EMAIL_PROVIDER
    else process.env.EMAIL_PROVIDER = oldProvider
    await f.clean()
  }
})

test('Inbox bypasses Widget visibility window; list cursors preserve microseconds and filter scope', async () => {
  const f = await fixture()
  const second = uuidv7()
  try {
    await pool.query("UPDATE conversation SET last_message_at='2026-01-01T00:00:00.123456Z' WHERE id=$1", [f.id])
    await pool.query(
      "INSERT INTO conversation(id,org_id,user_id,last_seq,last_message_at) VALUES ($1,$2,$3,1,'2026-01-01T00:00:00.123455Z')",
      [second, f.orgId, f.actor.customerId],
    )
    const first = await listConversations(runtime, f.orgId, listInput.parse({ status: 'all', limit: 1 }))
    assert.equal(first.items[0]!.id, f.id)
    const next = await listConversations(
      runtime,
      f.orgId,
      listInput.parse({ status: 'all', limit: 1, cursor: first.nextCursor }),
    )
    assert.equal(next.items[0]!.id, second)
    await assert.rejects(
      () => listConversations(runtime, f.orgId, listInput.parse({ status: 'open', cursor: first.nextCursor })),
      errorCode('invalid_cursor'),
    )
    assert.equal((await readInbox(runtime, f.orgId, f.id, pageInput.parse({}))).conversation.id, f.id)
    await assert.rejects(
      () => readInbox(runtime, 'other-org', f.id, pageInput.parse({})),
      errorCode('conversation_not_found'),
    )
  } finally {
    await pool.query('DELETE FROM conversation WHERE id=$1', [second])
    await f.clean()
  }
})

test('source relation rejects cross-tenant feedback and conversation image keys reject other organizations', async () => {
  const f = await fixture()
  const otherOrg = `other-${uuidv7()}`
  await pool.query('INSERT INTO organization(id,name,slug) VALUES ($1,$1,$1)', [otherOrg])
  try {
    await assert.rejects(
      () =>
        pool.query(
          "INSERT INTO post(id,org_id,author_id,title,content,slug,source_conversation_id) VALUES ($1,$2,$3,'Test','Test',$4,$5)",
          [uuidv7(), otherOrg, f.actor.customerId, 'Test', f.id],
        ),
      (e: unknown) => (e as { constraint: string }).constraint === 'post_source_conversation_fk',
    )
    const key = `uploads/${f.orgId}/image.png`
    assert.doesNotThrow(() => assertConversationImage(key, 'uploads', f.orgId))
    assert.throws(() => assertConversationImage(key, 'uploads', 'other-org'), errorCode('invalid_input'))
    assert.throws(
      () => assertConversationImage(`uploads/${f.orgId}/../other-org/x`, 'uploads', f.orgId),
      errorCode('invalid_input'),
    )
  } finally {
    await f.clean()
    await pool.query('DELETE FROM organization WHERE id=$1', [otherOrg])
  }
})

test('analytics publish after commit, count only first staff reply per round and skip command replays', async () => {
  const f = await fixture()
  try {
    await handoff(runtime, f.id, f.orgId, f.first.run!.id, 'user_requested')
    await handoff(runtime, f.id, f.orgId, f.first.run!.id, 'user_requested')
    await f.reply()
    await f.reply()
    await f.action('close')
    const next = await startRun(runtime, f.id, f.actor, send())
    await handoff(runtime, f.id, f.orgId, next.run!.id, 'knowledge_gap')
    const invalid = {
      action: 'reply' as const,
      requestId: uuidv7(),
      expectedLastSeq: Number((await f.row()).last_seq),
      content: { parts: [{ type: 'text' as const, text: 'Rollback' }] },
      notifyByEmail: false,
    }
    await assert.rejects(() => staffCommand(runtime, f.id, f.orgId, 'missing-user', invalid))
    await f.reply()
    const events = emitted.filter((e) => e.data.conversationId === f.id)
    assert.deepEqual(
      events.map((e) => e.name),
      ['inbox.handoff', 'inbox.staff-replied', 'inbox.closed', 'inbox.handoff', 'inbox.staff-replied'],
    )
  } finally {
    await f.clean()
  }
})

test('replaying a saved reply never writes another item or restarts its close deadline', async () => {
  const f = await fixture()
  try {
    await handoff(runtime, f.id, f.orgId, f.first.run!.id, 'knowledge_gap')
    const input = {
      action: 'reply' as const, requestId: uuidv7(), expectedLastSeq: Number((await f.row()).last_seq),
      content: { parts: [{ type: 'text' as const, text: 'One saved reply' }] }, notifyByEmail: true,
    }
    const saved = await staffCommand(runtime, f.id, f.orgId, f.staffId, input)
    const row = await f.row()
    const replay = await staffCommand(runtime, f.id, f.orgId, f.staffId, input)
    assert.equal(replay.replayed, true)
    assert.deepEqual(replay.item, saved.item)
    assert.equal(Number((await f.row()).last_seq), Number(row.last_seq))
    assert.equal(+(await f.row()).state_due_at, +row.state_due_at)
  } finally { await f.clean() }
})

test('progress renews the durable deadline beyond 120 seconds and expired runs cannot revive', async () => {
  const f = await fixture()
  try {
    await pool.query("UPDATE agent_run SET started_at=now()-interval '5 minutes',deadline_at=now()+interval '1 minute' WHERE id=$1", [f.first.run!.id])
    const deadline = Date.now() + 120000
    assert.equal(await renewRun(runtime, f.id, f.actor, f.first.run!.id, deadline), true)
    const { rows: [task] } = await pool.query("SELECT schedule_at,status FROM scheduled_task WHERE ref_id=$1 AND kind='agent_deadline'", [f.first.run!.id])
    assert.equal(new Date(task.schedule_at).getTime(), deadline)
    assert.equal(task.status, 'pending')
    await inboxTick(runtime)
    assert.equal((await pool.query('SELECT status FROM agent_run WHERE id=$1', [f.first.run!.id])).rows[0].status, 'running')
    await pool.query("UPDATE agent_run SET deadline_at=now()-interval '1 second' WHERE id=$1", [f.first.run!.id])
    assert.equal(await renewRun(runtime, f.id, f.actor, f.first.run!.id, Date.now() + 120000), false)
    await transaction(runtime, client => syncRunTask(client, f.first.run!.id))
    await inboxTick(runtime)
    assert.equal((await pool.query('SELECT status FROM agent_run WHERE id=$1', [f.first.run!.id])).rows[0].status, 'failed')
    assert.equal((await f.row()).status, 'ai_handling')
    const retried = await startRun(runtime, f.id, f.actor, { action: 'retry', trigger_item_id: f.first.item.id, idempotency_key: uuidv7() })
    assert.equal(retried.run.status, 'running')
  } finally { await f.clean() }
})

test('preflight time is included in the first-answer deadline', async () => {
  const deadline = Date.now() + 45000
  const f = await fixture(deadline)
  try {
    assert.equal(new Date(f.first.run!.deadline_at).getTime(), deadline)
    const { rows: [task] } = await pool.query("SELECT schedule_at FROM scheduled_task WHERE ref_id=$1 AND kind='agent_deadline'", [f.first.run!.id])
    assert.equal(new Date(task.schedule_at).getTime(), deadline)
  } finally { await f.clean() }
})


test('incremental history reports failed runs even when no new message was added', async () => {
  Object.assign(globalThis, { getQuery, getRouterParam })
  const f = await fixture()
  try {
    const event = createEvent({ url: `/api/widget/conversations/${f.id}/items?afterSeq=1`, headers: { host: 'localhost' }, method: 'GET' } as IncomingMessage, {} as ServerResponse)
    event.context.params = { id: f.id }
    const before = await readConversationItems(event, f.actor)
    assert.equal(before.items.length, 0)
    assert.equal(before.runs.at(-1)?.status, 'running')
    await failRun(runtime, f.first.run!.id, 'ai_timeout')
    const after = await readConversationItems(event, f.actor)
    assert.equal(after.items.length, 0)
    assert.equal(after.runs.at(-1)?.status, 'failed')
    assert.equal(after.runs.at(-1)?.error, 'ai_timeout')
  } finally { await f.clean() }
})
