import { pgTable, text, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import { organization, user } from './auth'

// Bookkeeping for long-lived agent credentials. The credential ITSELF is not
// here: it is an ordinary better-auth `session` row, minted with a far-future
// expiresAt and presented as `Authorization: Bearer <session.token>`.
//
// That indirection is the whole design. The bearer plugin rewrites the header
// into a session cookie before any better-auth endpoint runs, so an agent
// authenticates through exactly the same path as a browser — including
// auth.api.hasPermission, which requireOrgPermission delegates to, and
// customSession, which attaches the orgList that requireOrgMember reads.
// Nothing in server/utils/auth.ts has to know agents exist.
//
// This table therefore holds only what a session row cannot: a human label, the
// owning org, and a display prefix. The raw token is never stored here — it
// lives once in the session row and is shown once in the create response.
export const agentToken = pgTable('agent_token', {
  id: text('id').primaryKey().$defaultFn(() => uuidv7()),
  orgId: text('org_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
  // The robot identity this token authenticates as. Cascade means deleting the
  // robot user from the Members page also removes this row — and, through
  // session.user_id, the credential itself. That is the owner's escape hatch.
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  // session.id. Deliberately no foreign key: better-auth owns that table and a
  // constraint of ours would make its migrations our problem. Revoke deletes
  // both rows explicitly rather than relying on a cascade.
  sessionId: text('session_id').notNull(),
  label: text('label'),
  // First characters of the raw token, so the dashboard can tell two tokens
  // apart without being able to reveal either. Display only.
  prefix: text('prefix').notNull(),
  role: text('role').notNull(),
  // Whether this token may delete content. Separate from the role on purpose:
  // deleting is the one thing an agent does that cannot be undone, so it is a
  // capability an owner grants deliberately rather than something that arrives
  // bundled with `manager`. Off by default, and revocable at any time without
  // re-minting the token — see server/middleware/agent-delete-guard.ts, which
  // is where it is actually enforced.
  allowDelete: boolean('allow_delete').notNull().default(false),
  // Who minted it. An org owner's user id — for the audit line in the UI.
  createdBy: text('created_by').notNull(),
  // Mirrors session.expires_at. Duplicated so the list can show an expiry (and
  // mark a token expired) without joining better-auth's table.
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_agent_token_org').on(t.orgId),
  uniqueIndex('idx_agent_token_session').on(t.sessionId),
])

export const agentTokenRelations = relations(agentToken, ({ one }) => ({
  organization: one(organization, { fields: [agentToken.orgId], references: [organization.id] }),
  user: one(user, { fields: [agentToken.userId], references: [user.id] }),
}))
