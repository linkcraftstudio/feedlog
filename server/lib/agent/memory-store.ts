import { MemoryPG } from '@mastra/pg'
import type { Pool } from 'pg'
import type { MastraDBMessage } from '@mastra/core/agent'
import type { StorageListMessagesInput, StorageListMessagesByResourceIdInput } from '@mastra/core/storage'

// Projection happens in PostgreSQL: legacy base64 must never reach the Node JSON parser.
const projection = `jsonb_build_object('format',2,'metadata',
  CASE WHEN octet_length((content::jsonb->'metadata')::text) <= 16384 THEN content::jsonb->'metadata' ELSE '{}'::jsonb END,
  'parts', coalesce((SELECT jsonb_agg(CASE
    WHEN p->>'type'='file' THEN jsonb_build_object('type','text','text','[Earlier image: use read_conversation_images to inspect the original attachment.]')
    WHEN octet_length(p::text)>98304 THEN jsonb_build_object('type','text','text','[Earlier content exceeds the context budget.]')
    ELSE p END ORDER BY n)
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(content::jsonb->'parts')='array' THEN content::jsonb->'parts' ELSE '[]'::jsonb END)
    WITH ORDINALITY AS parts(p,n) WHERE n<=32), '[]'::jsonb))`

export class BoundedMemoryPG extends MemoryPG {
  constructor(private pool: Pool) { super({ pool, schemaName: 'public' }) }
  private async read(where: string, values: unknown[], limit = 40): Promise<MastraDBMessage[]> {
    const { rows } = await this.pool.query(`WITH recent AS MATERIALIZED (
      SELECT id,content,role,type,"createdAt",thread_id,"resourceId" FROM mastra_messages
      WHERE ${where} ORDER BY "createdAt" DESC,id DESC LIMIT ${Math.min(40, limit)}
    ), projected AS MATERIALIZED (
      SELECT id,role,type,"createdAt",thread_id AS "threadId","resourceId",${projection} AS content FROM recent
    ), budgeted AS (
      SELECT *,sum(octet_length(content::text)) OVER (ORDER BY "createdAt" DESC,id DESC) AS bytes FROM projected
    ) SELECT id,role,type,"createdAt","threadId","resourceId",content FROM budgeted
      WHERE bytes<=262144 ORDER BY "createdAt",id`, values)
    return rows.map(row => ({ ...row, createdAt: new Date(row.createdAt) }))
  }
  override async listMessages(args: StorageListMessagesInput) {
    // This store deliberately exposes one bounded context window, not an unbounded archive API.
    if (args.include?.length || args.filter?.metadata) throw new Error('Unsupported memory query')
    const ids = Array.isArray(args.threadId) ? args.threadId : [args.threadId]
    const values: unknown[] = [ids, args.resourceId ?? null]
    let where = 'thread_id=ANY($1::text[]) AND ($2::text IS NULL OR "resourceId"=$2)'
    const range = args.filter?.dateRange
    if (range?.start) { values.push(range.start); where += ` AND "createdAt" ${range.startExclusive ? '>' : '>='} $${values.length}` }
    if (range?.end) { values.push(range.end); where += ` AND "createdAt" ${range.endExclusive ? '<' : '<='} $${values.length}` }
    const limit = typeof args.perPage === 'number' ? Math.max(0, Math.min(40, args.perPage)) : 40
    const messages = args.page && args.page > 0 ? [] : await this.read(where, values, limit)
    if (args.orderBy?.direction === 'DESC') messages.reverse()
    return { messages, total: messages.length, page: args.page ?? 0, perPage: limit, hasMore: false }
  }
  override async listMessagesById({ messageIds }: { messageIds: string[] }) {
    return { messages: await this.read('id=ANY($1::text[])', [messageIds.slice(0, 40)]) }
  }
  override async listMessagesByResourceId(args: StorageListMessagesByResourceIdInput) {
    if (args.include?.length || args.filter) throw new Error('Unsupported memory query')
    const messages = args.page && args.page > 0 ? [] : await this.read('"resourceId"=$1', [args.resourceId])
    return { messages, total: messages.length, page: args.page ?? 0, perPage: 40, hasMore: false }
  }
}
