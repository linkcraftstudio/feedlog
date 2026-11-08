import { takeInboxEvents, type InboxEvent } from '../inbox/events'
import { Pool, type PoolClient } from 'pg'
import { Memory } from '@mastra/memory'
import { MastraCompositeStore } from '@mastra/core/storage'
import { BoundedMemoryPG } from './memory-store'
import { createError, type H3Event } from 'h3'
import type { Content, PageContext } from '../../../shared/agent/content'
import { stripMarkdown } from '../../../shared/utils/markdown'
import { CONVERSATION_RETENTION_DEFAULT_DAYS } from '../../../shared/constants/conversation'
import { HANDOFF_NOTICES, handoffNotice } from '../../../shared/inbox/state'

function initialize(connectionString: string, worker = false) {
  const options = { connectionString, connectionTimeoutMillis: 10000, statement_timeout: 20000 }
  const pool = new Pool({ ...options, max: worker ? 2 : 4 })
  // Business transactions reserve tool effects in Memory. Separate pools avoid
  // waiting for a connection already held by those same transactions.
  const memoryPool = new Pool({ ...options, max: worker ? 1 : 2 })
  const storage = new MastraCompositeStore({ id: 'feedlog-agent', disableInit: true, domains: {
    memory: new BoundedMemoryPG(memoryPool), threadState: false,
  } })
  const memory = new Memory({ storage, options: { lastMessages: false, generateTitle: false, semanticRecall: false, workingMemory: { enabled: false } } })
  return { pool, memory, publishInboxEvent: undefined as ((input: InboxEvent) => void) | undefined, close: async () => { await memory.settled(); await Promise.all([pool.end(), memoryPool.end()]) } }
}
export type AgentRuntime = ReturnType<typeof initialize>
let nodeRuntime: AgentRuntime | undefined

export function agentRuntime(event: H3Event): AgentRuntime {
  if (import.meta.preset === 'cloudflare-module' || import.meta.preset === 'cloudflare-pages') {
    // Hyperdrive sockets belong to one Worker invocation.
    if (!event.context.feedlogAgentRuntime) {
      const binding = (globalThis as typeof globalThis & { __env__?: { POSTGRES?: { connectionString: string } }; POSTGRES?: { connectionString: string } }).__env__?.POSTGRES || (globalThis as typeof globalThis & { POSTGRES?: { connectionString: string } }).POSTGRES
      if (!binding) throw new Error('POSTGRES Hyperdrive binding not found')
      event.context.feedlogAgentRuntime = initialize(binding.connectionString, true)
    }
    return requestRuntime(event, event.context.feedlogAgentRuntime)
  }
  return requestRuntime(event, nodeRuntime ??= initialize(process.env.DATABASE_URL!))
}

function requestRuntime(event: H3Event, runtime: AgentRuntime): AgentRuntime {
  return { ...runtime, publishInboxEvent: input => publishDomainEvent(event, createDomainEvent(input)) }
}

export async function withAgentRuntime<T>(event: H3Event, action: () => Promise<T>): Promise<T> {
  try { return await action() }
  finally {
    if (event.context.feedlogAgentRuntime) {
      const runtime = event.context.feedlogAgentRuntime as AgentRuntime
      event.waitUntil(Promise.resolve(event.context.feedlogAgentTask).finally(() => runtime.close()))
    }
  }
}

export function agentError(statusCode: number, code: string, message: string): never {
  throw createError({ statusCode, message, data: { code } })
}
export async function widgetActor(event: H3Event) {
  const { session, orgId } = await requireAuthInOrg(event)
  const { pool } = agentRuntime(event)
  const { rows: [settings] } = await pool.query('SELECT enabled,conversation_retention_days FROM organization_widget WHERE org_id=$1', [orgId])
  if (settings?.enabled === false) agentError(403, 'widget_disabled', 'Widget is not enabled')
  return { session, orgId, customerId: session.user.id, requestOrigin: getRequestURL(event).origin, retentionDays: settings?.conversation_retention_days ?? CONVERSATION_RETENTION_DEFAULT_DAYS }
}
export type Actor = Awaited<ReturnType<typeof widgetActor>>

export async function transaction<T>(runtime: Pick<AgentRuntime, 'pool'> & Partial<Pick<AgentRuntime, 'publishInboxEvent'>>, fn: (client: PoolClient) => Promise<T>, repeatableRead = false): Promise<T> {
  const client = await runtime.pool.connect()
  try {
    await client.query(repeatableRead ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN')
    const value = await fn(client)
    await client.query('COMMIT')
    for (const event of takeInboxEvents(client)) {
      try { runtime.publishInboxEvent?.(event) }
      catch { console.warn('[inbox] Could not publish domain event', { name: event.name }) }
    }
    return value
  } catch (error) { await client.query('ROLLBACK'); throw error }
  finally { takeInboxEvents(client); client.release() }
}
export async function lockConversation(client: PoolClient, id: string, actor: Actor, allowEmpty = false) {
  const { rows: [row] } = await client.query(`SELECT * FROM conversation WHERE id=$1 AND org_id=$2 AND user_id=$3
    AND last_message_at > now()-make_interval(days=>$4) AND (last_seq>0 OR $5) FOR UPDATE`, [id, actor.orgId, actor.customerId, actor.retentionDays, allowEmpty])
  if (!row) agentError(404, 'conversation_not_found', 'Conversation not found')
  return row
}
export async function appendItem(client: PoolClient, input: { id: string; conversationId: string; author: 'customer' | 'agent' | 'staff' | 'system'; userId?: string; content: Content; context?: PageContext | null; runId?: string; requestHash?: string }) {
  const preview = stripMarkdown(input.content.parts.map(part => part.type === 'text' ? part.text : 'title' in part ? part.title : '').join(' ')).slice(0, 200) || 'Image'
  const internal = input.author === 'system'
  const { rows: [row] } = await client.query(`UPDATE conversation SET last_seq=last_seq+1,
    last_message_at=CASE WHEN $4 THEN last_message_at ELSE clock_timestamp() END,
    preview_text=CASE WHEN $4 THEN preview_text ELSE $3::text END,
    title=CASE WHEN $4 THEN title ELSE coalesce(title,$3::text) END,
    unread=CASE WHEN $2 THEN true ELSE unread END WHERE id=$1 RETURNING last_seq`, [input.conversationId, input.author === 'agent' || input.author === 'staff', preview, internal])
  const { rows: [item] } = await client.query(`INSERT INTO conversation_item (id,conversation_id,seq,author_type,author_user_id,content,context,agent_run_id,request_hash,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()) RETURNING *`, [input.id, input.conversationId, row.last_seq, input.author, input.userId ?? null, JSON.stringify(input.content), input.context ? JSON.stringify(input.context) : null, input.runId ?? null, input.requestHash ?? null])
  return item
}
export function publicItem(item: Record<string, unknown>) {
  if (item.author_type === 'system') {
    const part = (item.content as Content).parts.find(part => part.type === 'system_event')
    if (!part || part.type !== 'system_event' || part.kind !== 'handoff' || part.reason === 'ai_error') return null
    const noticeKind = handoffNotice(part.reason, part.rule?.id)
    const text = part.customerNotice ?? HANDOFF_NOTICES[noticeKind]
    return { id: item.id, seq: Number(item.seq), authorType: 'system' as const, notice: 'handoff' as const, handoffNotice: noticeKind, ...(part.customerNotice ? { customerNotice: part.customerNotice } : {}), content: { parts: [{ type: 'text' as const, text }] }, context: null, agentRunId: null, createdAt: item.created_at }
  }
  return { id: item.id, seq: Number(item.seq), authorType: item.author_type, author: item.author_type === 'staff' ? { name: item.staff_name as string | null ?? null } : null, content: item.content, context: item.context, agentRunId: item.agent_run_id, createdAt: item.created_at }
}
export function publicRun(run: Record<string, unknown>) {
  return { id: run.id, triggerItemId: run.trigger_item_id, status: run.status, error: run.error, startedAt: run.started_at, deadlineAt: run.deadline_at, finishedAt: run.finished_at }
}
