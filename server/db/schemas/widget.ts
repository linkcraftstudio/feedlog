import { pgTable, text, boolean, varchar, jsonb, timestamp, uuid, integer, primaryKey, index } from 'drizzle-orm/pg-core'
import { relations, sql } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import { organization } from './auth'
import { CONVERSATION_RETENTION_DEFAULT_DAYS } from '../../../shared/constants/conversation'
import type { WidgetCustomRule } from '../../../shared/constants/widget-rules'

// One row per org, created lazily on first save (no row = all defaults). Writes
// go through a validating server endpoint, never a client-side metadata write.
export const organizationWidget = pgTable('organization_widget', {
  orgId: text('org_id').primaryKey().references(() => organization.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(true),
  supportEmail: varchar('support_email', { length: 320 }),
  disabledBuiltins: jsonb('disabled_builtins').$type<string[]>().notNull().default([]),
  customRules: jsonb('custom_rules').$type<WidgetCustomRule[]>().notNull().default([]),
  conversationRetentionDays: integer('conversation_retention_days').notNull().default(CONVERSATION_RETENTION_DEFAULT_DAYS),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
})

export const organizationWidgetRelations = relations(organizationWidget, ({ one }) => ({
  organization: one(organization, { fields: [organizationWidget.orgId], references: [organization.id] }),
}))

// A row = the post author has an unread admin update; no row = none. Written on
// admin reply / status change (author only), deleted when the author opens it.
export const postUnread = pgTable('post_unread', {
  postId: uuid('post_id').notNull(),
  userId: text('user_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.postId, t.userId] }),
])

// One widget chat thread, visible only to the visitor who started it. Created
// lazily with its first message, so a row here always has at least one.
export const conversation = pgTable('conversation', {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  orgId: text('org_id').notNull(),
  userId: text('user_id').notNull(),
  // NULL = never reached a terminal reply; the list falls back to the first message.
  title: varchar({ length: 200 }),
  previewText: text('preview_text'),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
  unread: boolean().notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_conversation_owner').on(t.orgId, t.userId, sql`${t.lastMessageAt} DESC`, sql`${t.id} DESC`),
])

// Both sides of a conversation, in the order they happened.
export const message = pgTable('message', {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  conversationId: uuid('conversation_id').notNull(),
  role: varchar({ length: 16 }).notNull(),
  // assistant only: which of the four AI outcomes this turn was.
  kind: varchar({ length: 16 }),
  text: text().notNull(),
  images: jsonb().$type<string[]>().notNull().default([]),
  // A pointer, not a snapshot — the card renders the post's current values, and
  // a deleted post just stops joining.
  postId: uuid('post_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_message_conversation').on(t.conversationId, t.createdAt, t.id),
])
