// Pure notification helpers — no DB, no Nuxt runtime, so they unit-test in
// isolation (pure functions are the highest-value tests). The
// DB-touching emit/send logic lives in server/utils/notifications.ts.

import { type NotificationTypeKey } from '../constants/notifications'

export interface OrgListSession {
  orgList?: { orgId: string; role: string }[]
}

// A comment author is an admin (→ official reply) when their session role in
// this org is owner or manager — read straight from the session, no DB query.
// Portal SSO sessions carry no orgList, so they are never admins.
export function isActorAdmin(session: OrgListSession, orgId: string): boolean {
  const role = session.orgList?.find(o => o.orgId === orgId)?.role
  return role === 'owner' || role === 'manager'
}

// The comment decision table: which event types a new comment fires. Only an
// admin's top-level comment notifies anyone (official reply → owner + voters).
// A reply notifies nobody, and neither does an ordinary user's top-level
// comment — both are deliberate, not gaps.
export function resolveCommentEvents(input: { isTopLevel: boolean; authorIsAdmin: boolean }): NotificationTypeKey[] {
  if (!input.isTopLevel) return []
  if (input.authorIsAdmin) return ['post.admin_replied']
  return []
}
