// Pure notification helpers — no DB, no Nuxt runtime, so they unit-test in
// isolation (pure functions are the highest-value tests). The
// DB-touching emit/send logic lives in server/utils/notifications.ts.

import type { NotificationTypeKey } from '../constants/notifications'

export interface OrgListSession {
  orgList?: { orgId: string; role: string; suspended?: boolean }[]
}

// A comment author is an admin (→ official reply) when their session role in
// this org is owner or manager — read straight from the session, no DB query.
// Portal SSO sessions carry no orgList, so they are never admins.
export function isActorAdmin(session: OrgListSession, orgId: string): boolean {
  const row = session.orgList?.find(o => o.orgId === orgId)
  return !row?.suspended && (row?.role === 'owner' || row?.role === 'manager')
}

// The subscriber-side comment decision table: only an admin's top-level comment
// notifies subscribers (official reply → owner + voters). A reply or an ordinary
// user's comment notifies none of them.
export function resolveCommentEvents(input: { isTopLevel: boolean; authorIsAdmin: boolean }): NotificationTypeKey[] {
  if (!input.isTopLevel) return []
  if (input.authorIsAdmin) return ['post.admin_replied']
  return []
}
