import type { PoolClient } from 'pg'
import { uuidv7 } from 'uuidv7'

export function replyCloseDelayMs() {
  return 48 * 3600000
}

// Call only inside the transaction which owns the conversation/run change.
export async function syncConversationTask(client: PoolClient, id: string) {
  await client.query(`INSERT INTO scheduled_task(id,kind,ref_id,schedule_at,status)
    SELECT $2,'inbox_due',id,coalesce(state_due_at,clock_timestamp()),
      CASE WHEN state_due_at IS NULL THEN 'cancelled' ELSE 'pending' END FROM conversation WHERE id=$1
    ON CONFLICT (kind,ref_id) WHERE item_id IS NULL DO UPDATE
    SET schedule_at=excluded.schedule_at,status=excluded.status,updated_at=clock_timestamp()`, [id, uuidv7()])
}

export async function syncRunTask(client: PoolClient, id: string, requestOrigin?: string) {
  await client.query(`INSERT INTO scheduled_task(id,kind,ref_id,schedule_at,status,result)
    SELECT $2,'agent_deadline',id,deadline_at,CASE WHEN status='running' THEN 'pending' ELSE 'cancelled' END,$3
    FROM agent_run WHERE id=$1 ON CONFLICT (kind,ref_id) WHERE item_id IS NULL DO UPDATE
    SET schedule_at=excluded.schedule_at,status=excluded.status,result=coalesce(excluded.result,scheduled_task.result),updated_at=clock_timestamp()`, [id, uuidv7(), requestOrigin ? JSON.stringify({ requestOrigin }) : null])
}

export async function scheduleReplyEmail(client: PoolClient, conversationId: string, itemId: string, immediate = false) {
  await client.query(`INSERT INTO scheduled_task(id,kind,ref_id,item_id,schedule_at,delivery_mode)
    SELECT $1,'inbox_email',i.conversation_id,i.id,
      CASE WHEN $4 THEN i.created_at ELSE i.created_at+interval '5 minutes' END,
      CASE WHEN $4 THEN 'immediate' ELSE 'auto' END
    FROM conversation_item i JOIN conversation c ON c.id=i.conversation_id
    JOIN "user" u ON u.id=c.user_id
    WHERE i.id=$2 AND i.conversation_id=$3 AND i.author_type='staff'
      AND NOT coalesce(u.is_anonymous,false) AND nullif(btrim(u.email),'') IS NOT NULL
    ON CONFLICT (item_id) WHERE kind='inbox_email' DO NOTHING`, [uuidv7(), itemId, conversationId, immediate])
}
