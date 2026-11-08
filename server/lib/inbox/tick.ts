import { transaction } from '../agent/runtime'
import { eventItem, recoverLocked, type ConversationRow, type InboxRuntime } from './service'
import { deliverReplyTask } from './email'
import { deliverHandoffEmail } from './handoff-email'

export async function inboxTick(runtime: InboxRuntime) {
  const result = { closed: 0, resumed: 0, recoveredRuns: 0, emails: 0, failed: 0, hasMore: false }
  const started = Date.now()
  const { rows } = await runtime.pool.query(`SELECT id FROM scheduled_task WHERE kind<>'help_index' AND (
    (status='pending' AND schedule_at<=clock_timestamp()) OR
    (status='processing' AND updated_at<clock_timestamp()-interval '10 minutes') OR
    (status NOT IN ('pending','processing','done','cancelled') AND schedule_at<=clock_timestamp()))
    ORDER BY schedule_at,id LIMIT 101`)
  result.hasMore = rows.length > 100
  for (const candidate of rows.slice(0, 100)) {
    if (Date.now() - started >= 20000) { result.hasMore = true; break }
    // Durable lease before execution. Duplicate queue deliveries cannot claim it.
    const { rows: [task] } = await runtime.pool.query(`UPDATE scheduled_task SET status='processing',updated_at=date_trunc('milliseconds',clock_timestamp())
      WHERE id=$1 AND ((status='pending' AND schedule_at<=clock_timestamp()) OR
      (status='processing' AND updated_at<clock_timestamp()-interval '10 minutes') OR
      (status NOT IN ('pending','processing','done','cancelled') AND schedule_at<=clock_timestamp())) RETURNING *`, [candidate.id])
    if (!task) continue
    try {
      if (task.kind === 'inbox_handoff_email') {
        await deliverHandoffEmail(runtime, task)
        result.emails++
        continue
      }
      if (task.kind === 'inbox_email') {
        await deliverReplyTask(runtime, task)
        result.emails++
        continue
      }
      const outcome = await transaction(runtime, async client => {
        const { rows: [row] } = await client.query<ConversationRow>(`SELECT * FROM conversation WHERE id=
          CASE WHEN $2='agent_deadline' THEN (SELECT conversation_id FROM agent_run WHERE id=$1) ELSE $1 END FOR UPDATE`, [task.ref_id, task.kind])
        // Lock order matches business writes (conversation first, then task).
        const { rows: [owned] } = await client.query("SELECT * FROM scheduled_task WHERE id=$1 AND status='processing' AND updated_at=$2 FOR UPDATE", [task.id, task.updated_at])
        if (!owned) return null
        let outcome: 'closed' | 'resumed' | 'recoveredRuns' | null = null
        if (!['agent_deadline','inbox_due'].includes(task.kind)) throw new Error('Unknown scheduled task kind')
        if (row) {
          if (await recoverLocked(client, row)) outcome = 'recoveredRuns'
          else if (task.kind === 'inbox_due') {
            const { rows: [due] } = await client.query(`SELECT state_due_at<=clock_timestamp() AS due,
              EXISTS(SELECT 1 FROM agent_run WHERE conversation_id=$1 AND status='running') AS running
              FROM conversation WHERE id=$1`, [row.id])
            if (due.due && !due.running && ['ai_handling','pending','snoozed'].includes(row.status)) {
              const wake = row.status === 'snoozed'
              const status = wake ? 'open' : 'closed'
              await client.query('UPDATE conversation SET status=$2,state_due_at=NULL WHERE id=$1', [row.id, status])
              await eventItem(client, row.id, { kind: wake ? 'resumed' : 'closed', reason: 'timeout', fromStatus: row.status, toStatus: status })
              outcome = wake ? 'resumed' : 'closed'
            } else if (due.running || (row.state_due_at && !due.due)) {
              await client.query("UPDATE scheduled_task SET status='pending',schedule_at=greatest($2::timestamptz,clock_timestamp()+interval '1 minute'),updated_at=clock_timestamp() WHERE id=$1", [task.id, row.state_due_at])
              return null
            }
          }
        }
        await client.query("UPDATE scheduled_task SET status='done',updated_at=clock_timestamp() WHERE id=$1 AND status='processing'", [task.id])
        return outcome
      })
      if (outcome) result[outcome]++
    } catch {
      await runtime.pool.query(`UPDATE scheduled_task SET status='pending',schedule_at=clock_timestamp()+interval '1 minute',updated_at=clock_timestamp()
        WHERE id=$1 AND status='processing' AND updated_at=$2`, [task.id, task.updated_at])
      result.failed++
      console.warn('[inbox] Scheduled operation failed', { taskId: task.id, kind: task.kind })
    }
  }
  if (rows.length) console.info('[inbox] Scheduler batch completed', result)
  return result
}
