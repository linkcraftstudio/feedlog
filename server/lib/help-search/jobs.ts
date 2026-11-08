import { sql } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import type { ContentDatabase } from '../../services/content-context'

type JobDatabase = Pick<ContentDatabase, 'execute'>

// Call within the same transaction as the article write. A new task ID fences
// any worker still embedding an older version of the article.
export async function queueHelpIndex(db: JobDatabase, articleId: string) {
  const generationId = uuidv7()
  await db.execute(sql`INSERT INTO scheduled_task(id,kind,ref_id,schedule_at,status,attempts,result)
    SELECT ${generationId},'help_index',id,clock_timestamp(),'pending',0,NULL
    FROM help_article WHERE id=${articleId} AND status='published'
    ON CONFLICT(kind,ref_id) WHERE item_id IS NULL DO UPDATE SET
      id=excluded.id,schedule_at=excluded.schedule_at,status='pending',attempts=0,
      result=NULL,manual_retry=false,updated_at=clock_timestamp()`)
  await db.execute(sql`DELETE FROM help_article_chunk WHERE article_id=${articleId}
    AND EXISTS(SELECT 1 FROM help_article WHERE id=${articleId} AND status='published')`)
}

// An unchanged explicit save starts missing jobs or retries terminal failures.
// The conditional upsert preserves successful jobs and in-flight generations.
export async function ensureHelpIndex(db: JobDatabase, articleId: string) {
  const rows = await db.execute(sql`INSERT INTO scheduled_task(id,kind,ref_id,schedule_at,status,attempts,result,manual_retry)
    SELECT ${uuidv7()},'help_index',id,clock_timestamp(),'pending',0,NULL,true
    FROM help_article WHERE id=${articleId} AND status='published'
    ON CONFLICT(kind,ref_id) WHERE item_id IS NULL DO UPDATE SET
      id=excluded.id,schedule_at=excluded.schedule_at,status='pending',attempts=0,
      result=NULL,manual_retry=true,updated_at=clock_timestamp()
    WHERE scheduled_task.status='done' AND scheduled_task.result IS DISTINCT FROM 'indexed'
    RETURNING id`)
  return rows.length > 0
}

// Keep successful snapshots intact, but revoke pending/running worker generations.
// Publication filters make retained vectors unavailable immediately.
export async function pauseHelpIndex(db: JobDatabase, articleId: string) {
  await db.execute(sql`UPDATE scheduled_task SET id=${uuidv7()},status='done',result='paused',
    updated_at=clock_timestamp() WHERE kind='help_index' AND ref_id=${articleId}
    AND item_id IS NULL AND status IN ('pending','processing')`)
}

// The vector table intentionally has no article FK; keep cleanup in the writer.
export async function deleteHelpIndex(db: JobDatabase, articleId: string) {
  await db.execute(sql`DELETE FROM scheduled_task WHERE kind='help_index' AND ref_id=${articleId}`)
  await db.execute(sql`DELETE FROM help_article_chunk WHERE article_id=${articleId}`)
}
