import { sql } from 'drizzle-orm'
import { helpVectorsEnabled } from './embedding'

import type { HelpIndexStatus } from '../../../shared/types/help-index'

export function helpIndexBadgeEnabled() {
  return helpVectorsEnabled() && !!process.env.OPENAI_API_KEY?.trim()
}

// NULL hides the badge when advanced search has not been configured.
export function helpIndexStatus() {
  return helpIndexBadgeEnabled()
    ? sql<HelpIndexStatus | null>`CASE WHEN help_article.status='published' THEN COALESCE((SELECT CASE
        WHEN t.status='done' AND t.result='indexed' THEN 'ready'
        WHEN t.status='done' THEN 'failed'
        ELSE 'indexing' END FROM scheduled_task t
        WHERE t.kind='help_index' AND t.ref_id=help_article.id AND t.item_id IS NULL), 'not_indexed') ELSE NULL END`
    : sql<null>`NULL`
}

// Only terminal failures are user-facing; article publication status is separate.
// Keep the outer table qualified: single-table Drizzle selects unqualify column
// objects inside SQL, which would bind an unqualified id to the inner task row.
export function helpIndexError() {
  return helpVectorsEnabled()
    ? sql<string | null>`(SELECT t.result FROM scheduled_task t
        WHERE t.kind='help_index' AND t.ref_id=help_article.id AND t.item_id IS NULL
          AND help_article.status='published' AND t.status='done' AND t.result IS DISTINCT FROM 'indexed')`
    : sql<null>`NULL`
}
