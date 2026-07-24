import { pgTable, uuid, text, timestamp, primaryKey } from 'drizzle-orm/pg-core'

// Notification system storage — one LAYER-owned table (post_subscription).

// The in-memory payload handed to the email renderer (never stored).
export interface NotificationPayload {
  to?: string // status_changed: the new status
  note?: string // admin's optional note carried with a status change
  snippet?: string // comment excerpt for the email body
  actorName?: string // admin_replied: who replied (shown in the email)
  actorImage?: string | null // admin_replied: their avatar
}

// Who is subscribed to which post. A row = subscribed; no row = not. Authorship
// and votes insert a row (unless the actor is an org admin); the subscribe card
// and the DELETE endpoint add/remove rows. Recipient resolution reads this table
// directly across the merge family.
export const postSubscription = pgTable('post_subscription', {
  postId: uuid('post_id').notNull(),
  userId: text('user_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.postId, t.userId] }),
])
