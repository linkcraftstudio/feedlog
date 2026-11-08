import { isDeepStrictEqual } from 'node:util'
import { syncConversationTask, syncRunTask, replyCloseDelayMs } from '../inbox/tasks'
import { uuidv7 } from 'uuidv7'
import type { ChatInput, Content } from '../../../shared/agent/content'
import { eventItem, recoverLocked, completeTakeoverLocked, type ConversationRow } from '../inbox/service'
import type { RunTokenUsage } from '../../../shared/agent/usage'
import { handling, type InboxStatus } from '../../../shared/inbox/state'
import { agentError, appendItem, lockConversation, transaction, type AgentRuntime, type Actor } from './runtime'

export async function startRun(runtime: AgentRuntime, id: string, actor: Actor, input: ChatInput, firstAnswerDeadline = Date.now() + 120_000) {
  return transaction(runtime, async client => {
    // Serializes concurrent first sends before there is a row to lock.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [id])
    if (input.action === 'send') {
      await client.query('INSERT INTO conversation (id,org_id,user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [id, actor.orgId, actor.customerId])
    }
    let conversation = await lockConversation(client, id, actor, input.action === 'send')
    if (Number(conversation.last_seq) === 0) {
      const { rowCount } = await client.query('SELECT id FROM message WHERE conversation_id=$1 LIMIT 1', [id])
      if (rowCount) agentError(404, 'conversation_not_found', 'Conversation not found')
    }
    const triggerId = input.action === 'send' ? input.message.id : input.trigger_item_id
    const { rows: [duplicate] } = await client.query('SELECT * FROM agent_run WHERE conversation_id=$1 AND idempotency_key=$2', [id, input.idempotency_key])
    const { rows: [existing] } = await client.query('SELECT * FROM conversation_item WHERE conversation_id=$1 AND id=$2', [id, triggerId])
    if (input.action === 'send' && existing && (existing.author_type !== 'customer' || existing.author_user_id !== actor.customerId || !isDeepStrictEqual(existing.content, input.message.content) || !isDeepStrictEqual(existing.context, input.message.context))) {
      agentError(409, 'idempotency_conflict', 'Message ID belongs to different content')
    }
    if (duplicate) {
      if (duplicate.trigger_item_id !== triggerId) agentError(409, 'idempotency_conflict', 'Request key belongs to another message')
      return { run: duplicate, item: existing, duplicate: true, conversation, mode: handling(conversation.status) }
    }
    if (input.action === 'send' && existing) return { run: null, item: existing, duplicate: true, conversation, mode: handling(conversation.status) }
    if (await recoverLocked(client, conversation as ConversationRow)) {
      conversation = (await client.query('SELECT * FROM conversation WHERE id=$1', [id])).rows[0]
    }
    if (input.action === 'retry' && conversation.status !== 'ai_handling') agentError(409, 'retry_not_allowed', 'AI retries are unavailable after handoff or closure')
    if (input.action === 'send' && conversation.status === 'closed') {
      await client.query("UPDATE conversation SET status='ai_handling',priority=0,state_due_at=NULL WHERE id=$1", [id])
      await eventItem(client, id, { kind: 'reopened', reason: 'customer_message', fromStatus: 'closed', toStatus: 'ai_handling' })
      conversation.status = 'ai_handling'
    }
    const { rowCount: busy } = await client.query("SELECT id FROM agent_run WHERE conversation_id=$1 AND status='running'", [id])
    if (busy) agentError(409, 'conversation_busy', 'A reply is already in progress')
    let item = existing
    if (input.action === 'retry') {
      const { rows: [last] } = await client.query('SELECT id,author_type FROM conversation_item WHERE conversation_id=$1 ORDER BY seq DESC LIMIT 1', [id])
      const { rowCount: completed } = await client.query("SELECT id FROM agent_run WHERE trigger_item_id=$1 AND status='completed'", [triggerId])
      if (!item || last?.id !== item.id || last.author_type !== 'customer' || completed) agentError(409, 'retry_not_allowed', 'Only the latest unanswered message can be retried')
    } else {
      const { rowCount: conflict } = await client.query('SELECT id FROM conversation_item WHERE id=$1', [triggerId])
      if (conflict) agentError(409, 'idempotency_conflict', 'Message already exists; retry its execution instead')
      item = await appendItem(client, { id: triggerId, conversationId: id, author: 'customer', userId: actor.customerId, content: input.message.content, context: input.message.context })
    }
    if (conversation.status !== 'ai_handling') {
      if (conversation.status !== 'open') {
        await eventItem(client, id, { kind: 'customer_resumed', reason: 'customer_message', fromStatus: conversation.status, toStatus: 'open' })
      }
      const { rows: [current] } = await client.query("UPDATE conversation SET status='open',state_due_at=NULL WHERE id=$1 RETURNING *", [id])
      await syncConversationTask(client, id)
      return { run: null, item, duplicate: false, conversation: current, mode: 'human' as const }
    }
    await client.query('UPDATE conversation SET state_due_at=NULL WHERE id=$1', [id])
    await syncConversationTask(client, id)
    if (Date.now() >= firstAnswerDeadline) agentError(408, 'ai_timeout', 'The response timed out; please retry')
    const { rows: [run] } = await client.query("INSERT INTO agent_run (id,conversation_id,trigger_item_id,idempotency_key,deadline_at) VALUES ($1,$2,$3,$4,$5) RETURNING *", [uuidv7(), id, triggerId, input.idempotency_key, new Date(firstAnswerDeadline)])
    await syncRunTask(client, run.id, actor.requestOrigin)
    return { run, item, duplicate: false, conversation: (await client.query('SELECT * FROM conversation WHERE id=$1', [id])).rows[0], mode: 'ai' as const }
  }).catch(error => {
    if (error.code === '23505') agentError(409, 'idempotency_conflict', 'Message ID or request key is already in use')
    throw error
  })
}
export async function failRun(runtime: AgentRuntime, runId: string, message: string) {
  return transaction(runtime, async client => {
    const { rows: [row] } = await client.query<ConversationRow>('SELECT * FROM conversation WHERE id=(SELECT conversation_id FROM agent_run WHERE id=$1) FOR UPDATE', [runId])
    await client.query("UPDATE agent_run SET status='failed',error=$2,finished_at=now() WHERE id=$1 AND status='running'", [runId, message])
    await syncRunTask(client, runId)
    return row ? completeTakeoverLocked(client, row, runId) : null
  })
}

export async function completeRun(runtime: AgentRuntime, id: string, actor: Actor, runId: string, replyId: string, content: Content, usage: RunTokenUsage | null = null) {
  return transaction(runtime, async client => {
    const row = await lockConversation(client, id, actor)
    const { rowCount } = await client.query("SELECT id FROM agent_run WHERE id=$1 AND conversation_id=$2 AND status='running' AND deadline_at>clock_timestamp()", [runId, id])
    if (!rowCount || row.status !== 'ai_handling') throw new Error('Run no longer active')
    const reply = await appendItem(client, { id: replyId, conversationId: id, author: 'agent', content, runId })
    await client.query('UPDATE conversation SET state_due_at=$2::timestamptz WHERE id=$1', [id, new Date(new Date(reply.created_at).getTime() + replyCloseDelayMs())])
    await client.query("UPDATE agent_run SET status='completed',finished_at=clock_timestamp(),usage=$2 WHERE id=$1", [runId, usage ? JSON.stringify(usage) : null])
    const takeover = await completeTakeoverLocked(client, row as ConversationRow, runId)
    await syncConversationTask(client, id)
    await syncRunTask(client, runId)
    return { lastSeq: Number(reply.seq), takeover }
  })
}

export async function readStoppedRun(runtime: Pick<AgentRuntime, 'pool'>, id: string, orgId: string, runId: string) {
  const { rows: [row] } = await runtime.pool.query<{ status: InboxStatus; last_seq: string; notice_id: string | null; content: Content | null }>(`
    SELECT c.status,c.last_seq,notice.id AS notice_id,notice.content FROM conversation c
    JOIN agent_run r ON r.conversation_id=c.id AND r.id=$3
    JOIN conversation_item trigger ON trigger.id=r.trigger_item_id
    LEFT JOIN LATERAL (
      SELECT i.id,i.content FROM conversation_item i WHERE i.conversation_id=c.id AND i.seq>trigger.seq
        AND i.author_type='system' AND (i.id='handoff:' || r.id::text
          OR i.content->'parts' @> '[{"type":"system_event","kind":"takeover"}]'::jsonb)
      ORDER BY i.seq DESC LIMIT 1
    ) notice ON true
    WHERE c.id=$1 AND c.org_id=$2 AND r.id=(
      SELECT id FROM agent_run WHERE conversation_id=c.id ORDER BY started_at DESC,id DESC LIMIT 1
    )`, [id, orgId, runId])
  return row ?? null
}

// Use the same lock order as completion, handoff and scheduled recovery.
export async function renewRun(runtime: AgentRuntime, conversationId: string, actor: Actor, runId: string, deadline: number) {
  return transaction(runtime, async client => {
    await lockConversation(client, conversationId, actor)
    const { rowCount } = await client.query(
      "UPDATE agent_run SET deadline_at=$3 WHERE id=$1 AND conversation_id=$2 AND status='running' AND deadline_at>clock_timestamp()",
      [runId, conversationId, new Date(deadline)],
    )
    if (rowCount) await syncRunTask(client, runId)
    return !!rowCount
  })
}
