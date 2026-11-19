import { pgTable, uuid, text, varchar, integer, boolean, timestamp, index, uniqueIndex, customType } from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import { organization } from './auth'
import type { HelpArticleStatus, HelpCollectionIcon } from '../../../shared/constants/help'

const tsvector = customType<{ data: string; driverParam: string }>({
  dataType() {
    return 'tsvector'
  },
})

export const helpCollection = pgTable('help_collection', {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  orgId: text('org_id').notNull(),
  name: varchar({ length: 100 }).notNull(),
  description: varchar({ length: 200 }),
  icon: varchar({ length: 32 }).$type<HelpCollectionIcon>().notNull(),
  visible: boolean().notNull().default(true),
  aiEnabled: boolean('ai_enabled').notNull().default(true),
  position: integer().notNull(),
}, t => [
  index('idx_help_collection_org').on(t.orgId, t.position, t.id),
])

export const helpArticle = pgTable('help_article', {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  orgId: text('org_id').notNull(),
  collectionId: uuid('collection_id').notNull(),
  shortId: varchar('short_id', { length: 6 }).notNull(),
  slug: varchar({ length: 120 }).notNull(),
  status: varchar({ length: 20 }).$type<HelpArticleStatus>().notNull().default('draft'),
  title: varchar({ length: 200 }).notNull(),
  description: varchar({ length: 300 }),
  content: text().notNull(),
  aiEnabled: boolean('ai_enabled').notNull().default(true),
  tsv: tsvector().notNull(),
  position: integer().notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('idx_help_article_org_shortid').on(t.orgId, t.shortId),
  index('idx_help_article_collection').on(t.collectionId, t.status, t.position, t.id),
  index('idx_help_article_org_status').on(t.orgId, t.status),
  index('idx_help_article_tsv').using('gin', t.tsv),
])

export const helpCollectionRelations = relations(helpCollection, ({ one, many }) => ({
  organization: one(organization, { fields: [helpCollection.orgId], references: [organization.id] }),
  articles: many(helpArticle),
}))

export const helpArticleRelations = relations(helpArticle, ({ one }) => ({
  organization: one(organization, { fields: [helpArticle.orgId], references: [organization.id] }),
  collection: one(helpCollection, { fields: [helpArticle.collectionId], references: [helpCollection.id] }),
}))
