import type { Pool } from 'pg'
import { updateWebsiteAiReference } from '../../server/services/web-source'
// Test the native resource services, without reintroducing a shared source API.
export async function updateAiTrainingReference(pool: Pool, orgId: string, input: { scope: 'source' | 'collection'; id: string; enabled: boolean }) {
  if (input.scope === 'source') return updateWebsiteAiReference(pool, orgId, input.id, input.enabled)
  // Pool fixtures support parameterized SQL; the production HTTP route uses
  // updateCollection's authorization/transaction and the same field assignment.
  const result = await pool.query('UPDATE help_collection SET ai_enabled=$3 WHERE id=$1 AND org_id=$2 RETURNING id', [input.id, orgId, input.enabled])
  if (!result.rows.length) throw new Error('Collection not found')
  return { aiEnabled: input.enabled }
}
