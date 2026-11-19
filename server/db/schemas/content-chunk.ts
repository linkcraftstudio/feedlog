import { pgTable, uuid, text, integer, index, primaryKey, customType } from 'drizzle-orm/pg-core'

const contentVector = customType<{ data: number[]; driverData: string }>({
  dataType: () => 'vector',
  toDriver: value => JSON.stringify(value),
  fromDriver: value => JSON.parse(value) as number[],
})

export const contentChunk = pgTable('content_chunk', {
  contentType: text('content_type').$type<'help_article' | 'web_page'>().notNull().default('help_article'),
  contentId: uuid('content_id').notNull(),
  ordinal: integer().notNull(),
  orgId: text('org_id').notNull(),
  generationId: uuid('generation_id').notNull(),
  heading: text().notNull(),
  body: text().notNull(),
  model: text().notNull(),
  indexVersion: text('index_version').notNull(),
  embedding: contentVector().notNull(),
}, t => [primaryKey({ columns: [t.contentType, t.contentId, t.ordinal] }), index('idx_content_chunk_org_type').on(t.orgId, t.contentType)])
