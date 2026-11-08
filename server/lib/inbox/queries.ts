import { createHash } from 'node:crypto'
import { z } from 'zod'
import { agentError, transaction } from '../agent/runtime'
import type { listInput, pageInput } from '../../../shared/inbox/schemas'
import { conversationResult, takeoverPendingSql, type InboxRuntime, type ConversationRow } from './service'

export async function listConversations(runtime: InboxRuntime, orgId: string, input: z.infer<typeof listInput>) {
  const signature = createHash('sha256')
    .update(JSON.stringify([input.status, input.priority, input.q, input.sort]))
    .digest('hex')
  const values: unknown[] = [orgId]
  const bind = (value: unknown) => {
    values.push(value)
    return `$${values.length}`
  }
  const conditions = ['c.org_id=$1', 'c.last_seq>0']
  if (input.status !== 'all') conditions.push(`c.status=${bind(input.status)}`)
  if (input.priority !== 'all') conditions.push(`c.priority=${bind(input.priority === 'high' ? 1 : 0)}`)
  if (input.q) {
    const pattern = bind(`%${input.q.replace(/[\\%_]/g, '\\$&')}%`)
    conditions.push(
      `(u.name ILIKE ${pattern} OR (NOT coalesce(u.is_anonymous,false) AND u.email ILIKE ${pattern}) OR c.title ILIKE ${pattern} OR EXISTS(SELECT 1 FROM conversation_item i,LATERAL jsonb_array_elements(i.content->'parts') p WHERE i.conversation_id=c.id AND p->>'type'='text' AND p->>'text' ILIKE ${pattern}))`,
    )
  }
  const desc = input.sort === 'newest'
  if (input.cursor) {
    let cursor
    try {
      cursor = z
        .tuple([z.iso.datetime(), z.uuid(), z.literal(signature)])
        .parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString()))
    } catch {
      agentError(422, 'invalid_cursor', 'Cursor does not match this query')
    }
    conditions.push(
      `(c.last_message_at,c.id) ${desc ? '<' : '>'} (${bind(cursor[0])}::timestamptz,${bind(cursor[1])}::uuid)`,
    )
  }
  const { rows } = await runtime.pool.query<
    ConversationRow & { cursor_time: string; customer_name: string | null; customer_image: string | null; customer_is_anonymous: boolean | null }
  >(
    `SELECT c.*,${takeoverPendingSql} AS takeover_pending,to_char(c.last_message_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time,u.name AS customer_name,u.image AS customer_image,u.is_anonymous AS customer_is_anonymous FROM conversation c LEFT JOIN "user" u ON u.id=c.user_id WHERE ${conditions.join(' AND ')} ORDER BY c.last_message_at ${desc ? 'DESC' : 'ASC'},c.id ${desc ? 'DESC' : 'ASC'} LIMIT ${bind(input.limit + 1)}`,
    values,
  )
  const items = rows.slice(0, input.limit)
  const last = items.at(-1)
  return {
    items: items.map((row) => ({
      ...conversationResult(row),
      customer: { id: row.user_id, name: row.customer_name, image: row.customer_image, isAnonymous: row.customer_is_anonymous ?? false },
    })),
    nextCursor:
      rows.length > input.limit && last
        ? Buffer.from(JSON.stringify([last.cursor_time, last.id, signature])).toString('base64url')
        : null,
  }
}
export async function readInbox(runtime: InboxRuntime, orgId: string, id: string, page: z.infer<typeof pageInput>) {
  return transaction(
    runtime,
    async (client) => {
      const {
        rows: [row],
      } = await client.query<ConversationRow>(`SELECT c.*,${takeoverPendingSql} AS takeover_pending FROM conversation c WHERE c.id=$1 AND c.org_id=$2 AND c.last_seq>0`, [
        id,
        orgId,
      ])
      if (!row) agentError(404, 'conversation_not_found', 'Conversation not found')
      const {
        rows: [customer],
      } = await client.query(
        'SELECT id,name,image,coalesce(is_anonymous,false) AS "isAnonymous",CASE WHEN is_anonymous IS TRUE THEN NULL ELSE email END AS email FROM "user" WHERE id=$1',
        [row.user_id],
      )
      const ascending = page.afterSeq !== undefined
      const { rows } = await client.query(
        `SELECT i.*,u.name AS author_name,u.image AS author_image,u.is_anonymous AS author_is_anonymous FROM conversation_item i LEFT JOIN "user" u ON u.id=i.author_user_id WHERE i.conversation_id=$1 AND ($2::bigint IS NULL OR i.seq${ascending ? '>' : '<'}$2) ORDER BY i.seq ${ascending ? 'ASC' : 'DESC'} LIMIT $3`,
        [id, page.afterSeq ?? page.beforeSeq ?? null, page.limit + 1],
      )
      const items = rows.slice(0, page.limit)
      if (!ascending) items.reverse()
      const { rows: emailTasks } = await client.query(`SELECT item_id,status,result,manual_retry,delivery_mode FROM scheduled_task
        WHERE kind='inbox_email' AND ref_id=$1`, [id])
      return {
        emails: Object.fromEntries(emailTasks.map(task => [task.item_id, {
          deliveryMode: task.delivery_mode,
          status: task.result ?? (task.status === 'cancelled' ? 'skipped' : 'pending'),
          canRetry: task.status === 'done' && task.result === 'failed' && !task.manual_retry,
        }])),
        conversation: conversationResult(row),
        customer,
        items: items.map((item) => ({
          id: item.id,
          seq: Number(item.seq),
          authorType: item.author_type,
          author: item.author_user_id
            ? { id: item.author_user_id, name: item.author_name, image: item.author_image, isAnonymous: item.author_is_anonymous ?? false }
            : null,
          content: item.content,
          context: item.context,
          agentRunId: item.agent_run_id,
          createdAt: item.created_at,
        })),
        nextBeforeSeq: !ascending && rows.length > page.limit ? Number(items[0].seq) : null,
        nextAfterSeq: items.length ? Number(items.at(-1).seq) : (page.afterSeq ?? Number(row.last_seq)),
        hasMore: rows.length > page.limit,
      }
    },
    true,
  )
}
