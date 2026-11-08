import { pgTable, uuid, text, integer, index, primaryKey, vector } from 'drizzle-orm/pg-core'

export const helpArticleChunk = pgTable('help_article_chunk', {
  articleId: uuid('article_id').notNull(),
  ordinal: integer().notNull(),
  orgId: text('org_id').notNull(),
  generationId: uuid('generation_id').notNull(),
  heading: text().notNull(),
  body: text().notNull(),
  model: text().notNull(),
  indexVersion: text('index_version').notNull(),
  embedding: vector({ dimensions: 768 }).notNull(),
}, t => [primaryKey({ columns: [t.articleId, t.ordinal] }), index('idx_help_chunk_org').on(t.orgId)])
