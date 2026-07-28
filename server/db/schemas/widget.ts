import { pgTable, text, boolean, varchar, jsonb, timestamp, uuid, primaryKey } from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { organization } from './auth'
import type { WidgetCustomRule } from '../../../shared/constants/widget-rules'

// One row per org, created lazily on first save (no row = all defaults). Writes
// go through a validating server endpoint, never a client-side metadata write.
export const organizationWidget = pgTable('organization_widget', {
  orgId: text('org_id').primaryKey().references(() => organization.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(true),
  supportEmail: varchar('support_email', { length: 320 }),
  disabledBuiltins: jsonb('disabled_builtins').$type<string[]>().notNull().default([]),
  customRules: jsonb('custom_rules').$type<WidgetCustomRule[]>().notNull().default([]),
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
