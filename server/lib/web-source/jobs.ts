import type { Pool, PoolClient } from 'pg'
import { uuidv7 } from 'uuidv7'
import { createError } from 'h3'

export async function webSourceTransaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect()
  try { await client.query('BEGIN'); const result = await action(client); await client.query('COMMIT'); return result }
  catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
export async function scheduleWebSource(client: PoolClient, sourceId: string) {
  await client.query(`UPDATE ai_training_website SET next_run=CASE WHEN paused OR frequency='manual' THEN NULL
    ELSE clock_timestamp()+CASE frequency WHEN 'biweekly' THEN interval '14 days' WHEN 'monthly' THEN interval '1 month' ELSE interval '7 days' END END,
    updated_at=clock_timestamp() WHERE id=$1`, [sourceId])
  await client.query("DELETE FROM scheduled_task WHERE kind='ai_training_website' AND ref_id=$1", [sourceId])
  await client.query(`INSERT INTO scheduled_task(id,kind,ref_id,schedule_at,status)
    SELECT $2,'ai_training_website',id,next_run,'pending' FROM ai_training_website WHERE id=$1 AND next_run IS NOT NULL`, [sourceId, uuidv7()])
}
export async function startWebSourceRun(client: PoolClient, orgId: string, sourceId: string, trigger: 'first' | 'manual' | 'scheduled', pageIds?: string[]) {
  const { rows: [source] } = await client.query('SELECT * FROM ai_training_website WHERE id=$1 AND org_id=$2 FOR UPDATE', [sourceId, orgId])
  if (!source) throw createError({ statusCode: 404, message: 'Source not found' })
  const active = await client.query("SELECT id FROM ai_training_website_run WHERE website_id=$1 AND status='running'", [sourceId])
  if (active.rows.length) {
    if (trigger === 'scheduled') { await scheduleWebSource(client, sourceId); return active.rows[0].id as string }
    throw createError({ statusCode: 409, message: 'A synchronization is already running' })
  }
  const { rows: pages } = await client.query(`SELECT id FROM ai_training_web_page WHERE website_id=$1 AND org_id=$2${pageIds ? ' AND id=ANY($3::uuid[])' : ''} ORDER BY id`, pageIds ? [sourceId, orgId, pageIds] : [sourceId, orgId])
  if (pageIds && pages.length !== new Set(pageIds).size) throw createError({ statusCode: 404, message: 'Page not found' })
  const runId = uuidv7()
  await client.query('INSERT INTO ai_training_website_run(id,website_id,scope,trigger,total) VALUES($1,$2,$3,$4,$5)', [runId, sourceId, pageIds ? 'selected' : 'full', trigger, pages.length])
  await client.query("UPDATE ai_training_web_page SET run_id=$2,sync_status='pending',metadata=metadata-'error'-'errorStage',attempt_count=0 WHERE id=ANY($1::uuid[])", [pages.map(page => page.id), runId])
  for (const page of pages) await client.query(`INSERT INTO scheduled_task(id,kind,ref_id,schedule_at,status)
    VALUES($1,'web_page',$2,clock_timestamp(),'pending')
    ON CONFLICT(kind,ref_id) WHERE item_id IS NULL DO UPDATE SET id=excluded.id,status='pending',attempts=0,result=NULL,schedule_at=excluded.schedule_at,updated_at=clock_timestamp()`, [uuidv7(), page.id])
  if (!pageIds) await scheduleWebSource(client, sourceId)
  if (!pages.length) await client.query("UPDATE ai_training_website_run SET status='done',finished_at=clock_timestamp() WHERE id=$1", [runId])
  return runId
}

export async function settleWebSourceRun(client: PoolClient, sourceId: string, runId: string, outcome: 'added' | 'updated' | 'unchanged' | 'failed') {
  // The source lock serializes page completions, run creation and removal.
  await client.query('SELECT id FROM ai_training_website WHERE id=$1 FOR UPDATE', [sourceId])
  await client.query(`UPDATE ai_training_website_run SET added=added+$2,updated=updated+$3,failed=failed+$4 WHERE id=$1 AND status='running'`, [runId, Number(outcome === 'added'), Number(outcome === 'updated'), Number(outcome === 'failed')])
  const pending = await client.query("SELECT 1 FROM ai_training_web_page WHERE website_id=$1 AND run_id=$2 AND sync_status IN ('pending','processing') LIMIT 1", [sourceId, runId])
  if (!pending.rows.length) {
    await client.query("UPDATE ai_training_website_run SET status=CASE WHEN failed=0 THEN 'done' ELSE 'failed' END,finished_at=clock_timestamp() WHERE id=$1 AND status='running'", [runId])
  }
}
