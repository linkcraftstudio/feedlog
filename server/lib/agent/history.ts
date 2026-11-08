import type { H3Event } from 'h3'
import { z } from 'zod'
import { pageInput } from '../../../shared/inbox/schemas'
import { handling } from '../../../shared/inbox/state'
import { type Actor, agentRuntime, agentError, transaction, publicItem, publicRun } from '#layers/feedlog/server/lib/agent/runtime'

export async function readConversationItems(event: H3Event, actor: Actor) {
  const id = z.uuid().safeParse(getRouterParam(event, 'id'))
  if (!id.success) agentError(404, 'conversation_not_found', 'Conversation not found')
  const query = pageInput.safeParse(getQuery(event))
  if (!query.success) agentError(422, 'invalid_message', 'Invalid page parameters')
  const runtime = agentRuntime(event)
  // Read-only ownership check; the scheduler owns abandoned executions.
  const args = [id.data, actor.orgId, actor.customerId, actor.retentionDays]
  const scope = 'id=$1 AND org_id=$2 AND user_id=$3 AND last_seq>0 AND last_message_at>now()-make_interval(days=>$4)'
  const { rowCount } = await runtime.pool.query(`SELECT id FROM conversation WHERE ${scope}`, args)
  if (!rowCount) agentError(404, 'conversation_not_found', 'Conversation not found')
  return transaction(runtime, async client => {
    const { rows: [conversation] } = await client.query(`SELECT id,title,last_seq,unread,status FROM conversation WHERE ${scope}`, args)
    if (!conversation) agentError(404, 'conversation_not_found', 'Conversation not found')
    const ascending = query.data.afterSeq !== undefined
    const { rows } = await client.query(`SELECT i.*,u.name AS staff_name FROM conversation_item i LEFT JOIN "user" u ON u.id=i.author_user_id AND i.author_type='staff' WHERE i.conversation_id=$1 AND ($2::bigint IS NULL OR i.seq${ascending ? '>' : '<'}$2) ORDER BY i.seq ${ascending ? 'ASC' : 'DESC'} LIMIT $3`, [id.data, query.data.afterSeq ?? query.data.beforeSeq ?? null, query.data.limit + 1])
    const items = rows.slice(0, query.data.limit)
    if (!ascending) items.reverse()
    // A run can fail without adding a message; incremental polling still needs its latest state.
    const { rows: runs } = await client.query(`SELECT * FROM agent_run WHERE conversation_id=$1 AND (trigger_item_id=ANY($2::text[]) OR id=ANY($3::uuid[]) OR ($4::boolean AND id=(SELECT id FROM agent_run WHERE conversation_id=$1 ORDER BY started_at DESC,id DESC LIMIT 1))) ORDER BY started_at,id`, [id.data, items.filter(i => i.author_type === 'customer').map(i => i.id), items.filter(i => i.agent_run_id).map(i => i.agent_run_id), ascending])
    return { conversation: { id: conversation.id, title: conversation.title, lastSeq: Number(conversation.last_seq), unread: conversation.unread, handling: handling(conversation.status) }, items: items.map(publicItem).filter(Boolean), runs: runs.map(publicRun), nextBeforeSeq: !ascending && rows.length > query.data.limit ? Number(items[0].seq) : null, nextAfterSeq: items.length ? Number(items.at(-1).seq) : query.data.afterSeq ?? Number(conversation.last_seq), hasMore: rows.length > query.data.limit }
  }, true)
}
