import { queueInboxEvent } from './events'
import { hasHumanSupport, scheduleHandoffEmail } from './handoff-email'
import { syncConversationTask, syncRunTask, scheduleReplyEmail, replyCloseDelayMs } from './tasks'
import { createHash } from 'node:crypto'
import { uuidv7 } from 'uuidv7'
import type { PoolClient } from 'pg'
import { agentError, appendItem, transaction, type AgentRuntime } from '../agent/runtime'
import type { Content, FeedbackPart } from '../../../shared/agent/content'
import type { StaffCommand } from '../../../shared/inbox/schemas'
import { handoffCustomerNotice, type HandoffRule, type HandoffReason, type InboxStatus, type SystemEventPart } from '../../../shared/inbox/state'

export type InboxRuntime = Pick<AgentRuntime, 'pool'> & Partial<Pick<AgentRuntime, 'publishInboxEvent'>>
export const takeoverPendingSql = `(c.status='ai_handling' AND EXISTS(
  SELECT 1 FROM agent_run r JOIN conversation_item trigger ON trigger.id=r.trigger_item_id
  JOIN conversation_item i ON i.conversation_id=r.conversation_id AND i.seq>trigger.seq
  WHERE r.conversation_id=c.id AND r.status='running' AND i.author_type='system'
    AND i.content->'parts' @> jsonb_build_array(jsonb_build_object('type','system_event','kind','takeover_requested','runId',r.id::text))
))`
export interface ConversationRow {
  id: string
  org_id: string
  user_id: string
  status: InboxStatus
  takeover_pending?: boolean
  priority: number
  state_due_at: Date | null
  last_seq: string | number
  title: string | null
  last_message_at: Date
  preview_text: string | null
  created_at: Date
  unread: boolean
}
export function conversationResult(row: ConversationRow) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    takeoverPending: row.takeover_pending ?? false,
    priority: row.priority ? ('high' as const) : ('normal' as const),
    stateDueAt: row.state_due_at,
    lastSeq: Number(row.last_seq),
    lastMessageAt: row.last_message_at,
    previewText: row.preview_text,
  }
}
export async function lockInbox(client: PoolClient, id: string, orgId: string) {
  const {
    rows: [row],
  } = await client.query<ConversationRow>(
    `SELECT c.*,${takeoverPendingSql} AS takeover_pending FROM conversation c WHERE c.id=$1 AND c.org_id=$2 AND c.last_seq>0 FOR UPDATE`,
    [id, orgId],
  )
  if (!row) agentError(404, 'conversation_not_found', 'Conversation not found')
  return row
}
export async function cancelRun(client: PoolClient, id: string, syncTasks = true) {
  const { rows } = await client.query(
    "UPDATE agent_run SET status='cancelled',finished_at=clock_timestamp(),error=NULL WHERE conversation_id=$1 AND status='running' RETURNING id",
    [id],
  )
  if (syncTasks) for (const run of rows) await syncRunTask(client, run.id)
  return rows
}
export async function eventItem(
  client: PoolClient,
  conversationId: string,
  part: Omit<SystemEventPart, 'type'>,
  options: { id?: string; userId?: string; requestHash?: string } = {},
) {
  return appendItem(client, {
    id: options.id ?? uuidv7(),
    conversationId,
    author: 'system',
    content: { parts: [{ type: 'system_event', ...part }] },
    ...options,
  })
}

// The caller owns the conversation lock and has already ended this run.
export async function completeTakeoverLocked(client: PoolClient, row: ConversationRow, runId: string) {
  if (row.status !== 'ai_handling') return null
  const { rows: [request] } = await client.query(`
    SELECT i.id,i.author_user_id FROM agent_run r
    JOIN conversation_item trigger ON trigger.id=r.trigger_item_id
    JOIN conversation_item i ON i.conversation_id=r.conversation_id AND i.seq>trigger.seq
    WHERE r.id=$2 AND r.conversation_id=$1 AND r.status IN ('completed','failed') AND i.author_type='system'
      AND i.content->'parts' @> jsonb_build_array(jsonb_build_object('type','system_event','kind','takeover_requested','runId',r.id::text))
      AND NOT EXISTS(SELECT 1 FROM agent_run newer WHERE newer.conversation_id=$1 AND (newer.started_at,newer.id)>(r.started_at,r.id))
    ORDER BY i.seq LIMIT 1`, [row.id, runId])
  if (!request) return null
  await client.query("UPDATE conversation SET status='open',state_due_at=NULL WHERE id=$1", [row.id])
  const item = await eventItem(client, row.id, { kind: 'takeover', reason: 'manual', fromStatus: 'ai_handling', toStatus: 'open', runId }, { id: `takeover:${request.id}`, userId: request.author_user_id })
  await syncConversationTask(client, row.id)
  return { id: item.id as string, seq: Number(item.seq) }
}
export async function handoffLocked(
  client: PoolClient,
  row: ConversationRow,
  runId: string,
  reason: HandoffReason,
  allowExpired = false,
  rule?: HandoffRule,
  feedbackResults: FeedbackPart[] = [],
  requestOrigin?: string,
  customerNotice?: string,
) {
  const noticeText = customerNotice === undefined ? undefined : handoffCustomerNotice.parse(customerNotice)
  const id = `handoff:${runId}`
  const {
    rows: [existing],
  } = await client.query('SELECT * FROM conversation_item WHERE id=$1 AND conversation_id=$2', [id, row.id])
  if (existing) return existing
  if (row.status !== 'ai_handling') return null
  const { rowCount } = await client.query(
    "SELECT id FROM agent_run WHERE id=$1 AND conversation_id=$2 AND status='running' AND ($3 OR deadline_at>clock_timestamp())",
    [runId, row.id, allowExpired],
  )
  if (!rowCount) return null
  if (!await hasHumanSupport(client, row.org_id)) {
    await client.query("UPDATE agent_run SET status='failed',error='support_unavailable',finished_at=clock_timestamp() WHERE id=$1 AND status='running'", [runId])
    await syncRunTask(client, runId)
    return await completeTakeoverLocked(client, row, runId)
  }
  // Successful business actions survive cancellation, including their visible receipts.
  if (feedbackResults.length) await appendItem(client, {
    id: `handoff-results:${runId}`, conversationId: row.id, author: 'agent',
    content: { parts: feedbackResults }, runId,
  })
  const cancelled = await cancelRun(client, row.id, false)
  await client.query("UPDATE conversation SET status='open',priority=$2,state_due_at=NULL WHERE id=$1", [
    row.id,
    ['knowledge_gap', 'support_rule'].includes(reason) ? 0 : 1,
  ])
  // Task cleanup must not block human handling. Stale tasks recheck the saved state.
  await client.query('SAVEPOINT handoff_tasks')
  try {
    for (const run of cancelled) await syncRunTask(client, run.id)
    await syncConversationTask(client, row.id)
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT handoff_tasks')
    console.warn('[inbox] Deferred handoff task cleanup', { conversationId: row.id, runId })
  }
  await client.query('RELEASE SAVEPOINT handoff_tasks')
  queueInboxEvent(client, {
    name: 'inbox.handoff',
    orgId: row.org_id,
    userId: null,
    data: { conversationId: row.id, reason },
  })
  const notice = await eventItem(client, row.id, { kind: 'handoff', reason, ...(reason === 'support_rule' && rule ? { rule } : {}), ...(noticeText ? { customerNotice: noticeText } : {}), fromStatus: row.status, toStatus: 'open' }, { id })
  await scheduleHandoffEmail(client, runId, requestOrigin)
  return notice
}
export async function handoff(
  runtime: InboxRuntime,
  id: string,
  orgId: string,
  runId: string,
  reason: HandoffReason,
  allowExpired = false,
  rule?: HandoffRule,
  feedbackResults: FeedbackPart[] = [],
  requestOrigin?: string,
  customerNotice?: string,
) {
  const save = (expired: boolean) => transaction(runtime, async (client) =>
    handoffLocked(client, await lockInbox(client, id, orgId), runId, reason, expired, rule, feedbackResults, requestOrigin, customerNotice),
  )
  try { return await save(allowExpired) }
  catch {
    // A fresh transaction recovers transient write failures without involving the customer.
    // The conversation/run locks still fence closed conversations and later AI rounds.
    console.warn('[inbox] Retrying handoff with human handling fallback', { conversationId: id, runId })
    return save(true)
  }
}
export async function recoverLocked(client: PoolClient, row: ConversationRow) {
  const {
    rows: [run],
  } = await client.query(
    "SELECT id FROM agent_run WHERE conversation_id=$1 AND status='running' AND deadline_at<=clock_timestamp()",
    [row.id],
  )
  if (!run) return false
  if (row.status === 'ai_handling') {
    await client.query("UPDATE agent_run SET status='failed',error='ai_timeout',finished_at=clock_timestamp() WHERE id=$1 AND status='running'", [run.id])
    await syncRunTask(client, run.id)
    await completeTakeoverLocked(client, row, run.id)
  } else await cancelRun(client, row.id)
  return true
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
export async function staffCommand(
  runtime: InboxRuntime,
  id: string,
  orgId: string,
  userId: string,
  input: StaffCommand,
) {
  const itemId = `cmd:${hash([id, userId, input.requestId])}`
  const { expectedLastSeq, requestId, ...payload } = input
  const fingerprint = hash(input.action === 'reply' ? { ...payload, notifyByEmail: input.notifyByEmail ?? false } : payload)
  return transaction(runtime, async (client) => {
    const row = await lockInbox(client, id, orgId)
    const {
      rows: [previous],
    } = await client.query('SELECT * FROM conversation_item WHERE id=$1', [itemId])
    if (previous) {
      if (previous.request_hash !== fingerprint)
        agentError(409, 'idempotency_conflict', 'Request ID belongs to different content')
      return { requestId, replayed: true, item: receipt(previous), conversation: conversationResult(row) }
    }
    if (Number(row.last_seq) !== expectedLastSeq)
      agentError(409, 'revision_conflict', 'Conversation changed. Review the latest messages before retrying.')
    let status = row.status
    let priority = row.priority
    let due: Date | null = null
    let item
    if (input.action === 'reply') {
      if (!['open', 'pending'].includes(status))
        agentError(409, 'state_conflict', 'Restore this conversation before replying')
      const {
        rows: [round],
      } = await client.query(
        `SELECT EXISTS(SELECT 1 FROM conversation_item WHERE conversation_id=$1 AND author_type='staff'
        AND seq>coalesce((SELECT max(seq) FROM conversation_item WHERE conversation_id=$1 AND author_type='system' AND content->'parts' @> '[{"type":"system_event","kind":"reopened"}]'::jsonb),0)) AS handled`,
        [id],
      )
      if (!round.handled)
        queueInboxEvent(client, { name: 'inbox.staff-replied', orgId, userId, data: { conversationId: id, itemId } })
      item = await appendItem(client, {
        id: itemId,
        conversationId: id,
        author: 'staff',
        userId,
        content: input.content as Content,
        requestHash: fingerprint,
      })
      status = 'pending'
      due = new Date(new Date(item.created_at).getTime() + replyCloseDelayMs())
      await scheduleReplyEmail(client, id, item.id, input.notifyByEmail)
    } else {
      const part: Omit<SystemEventPart, 'type'> = {
        kind: 'closed',
        reason: 'manual',
        fromStatus: row.status,
        toStatus: status,
      }
      if (input.action === 'takeover') {
        if (status !== 'ai_handling') agentError(409, 'state_conflict', 'Only AI conversations can be taken over')
        if (row.takeover_pending) agentError(409, 'no_change', 'A takeover is already waiting for this reply')
        const { rows: [run] } = await client.query("SELECT id FROM agent_run WHERE conversation_id=$1 AND status='running'", [id])
        status = run ? 'ai_handling' : 'open'
        part.kind = run ? 'takeover_requested' : 'takeover'
        if (run) part.runId = run.id
        due = run ? row.state_due_at : null
      } else if (input.action === 'snooze') {
        if (!['open', 'pending'].includes(status))
          agentError(409, 'state_conflict', 'This conversation cannot be snoozed')
        due = new Date(input.wakeAt)
        const {
          rows: [clock],
        } = await client.query('SELECT clock_timestamp() AS now')
        const delta = due.getTime() - new Date(clock.now).getTime()
        if (delta <= 0 || delta > 35 * 86400000) agentError(422, 'invalid_input', 'Choose a future time within 35 days')
        status = 'snoozed'
        part.kind = 'snoozed'
        part.dueAt = due.toISOString()
      } else if (input.action === 'resume') {
        if (status !== 'snoozed') agentError(409, 'state_conflict', 'Only snoozed conversations can be restored')
        status = 'open'
        part.kind = 'resumed'
      } else if (input.action === 'close') {
        if (status === 'closed') agentError(409, 'no_change', 'Conversation is already closed')
        status = 'closed'
        await cancelRun(client, id)
        queueInboxEvent(client, {
          name: 'inbox.closed',
          orgId,
          userId,
          data: { conversationId: id, fromStatus: row.status },
        })
      } else {
        priority = input.priority === 'high' ? 1 : 0
        if (priority === row.priority) agentError(409, 'no_change', 'Priority is unchanged')
        due = row.state_due_at
        part.kind = 'priority_changed'
        part.fromPriority = row.priority ? 'high' : 'normal'
        part.toPriority = input.priority
      }
      part.toStatus = status
      item = await eventItem(client, id, part, { id: itemId, userId, requestHash: fingerprint })
    }
    const {
      rows: [updated],
    } = await client.query<ConversationRow>(
      `UPDATE conversation c SET status=$2,priority=$3,state_due_at=$4 WHERE id=$1 RETURNING c.*,${takeoverPendingSql} AS takeover_pending`,
      [id, status, priority, due],
    )
    if (input.action !== 'set_priority') await syncConversationTask(client, id)
    return { requestId, replayed: false, item: receipt(item), conversation: conversationResult(updated!) }
  })
}
function receipt(item: { id: string; seq: string | number; created_at: Date }) {
  return { id: item.id, seq: Number(item.seq), createdAt: item.created_at }
}
