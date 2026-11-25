import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { member, organization, user } from '../db/schemas/auth'
import { memberPreference } from '../db/schemas/member-preferences'
import { resolveMemberNotifications, type MemberPreferenceUpdate } from '../../shared/schemas/member-preference'

type PreferenceDB = Pick<PgDatabase<PgQueryResultHKT>, 'select' | 'insert'>

export async function findOwnMemberPreference(db: PreferenceDB, orgId: string, userId: string) {
  const [row] = await db.select({
    memberId: member.id,
    role: member.role,
    email: user.email,
    organization: { id: organization.id, name: organization.name },
    preference: memberPreference,
  }).from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .leftJoin(memberPreference, eq(memberPreference.memberId, member.id))
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
    .limit(1)
  return row
}

export async function saveMemberNotifications(db: PreferenceDB, memberId: string, notifications: MemberPreferenceUpdate['notifications']) {
  const [row] = await db.insert(memberPreference).values({ memberId, notifications })
    .onConflictDoUpdate({
      target: memberPreference.memberId,
      // Merge at the write, including competing first inserts, so unrelated keys survive.
      set: {
        notifications: sql`${memberPreference.notifications} || ${JSON.stringify(notifications)}::jsonb`,
        updatedAt: new Date(),
      },
    })
    .returning({ notifications: memberPreference.notifications })
  return resolveMemberNotifications(row!.notifications)
}

export async function findStaffFeedbackRecipients(db: PreferenceDB, orgId: string, actorId: string) {
  const rows = await db.select({
    userId: member.userId,
    email: user.email,
    preference: memberPreference,
  }).from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .leftJoin(memberPreference, eq(memberPreference.memberId, member.id))
    .where(and(
      eq(member.organizationId, orgId),
      inArray(member.role, ['owner', 'manager']),
      isNull(member.suspendedAt),
      ne(member.userId, actorId),
    ))
  return rows.filter(row => resolveMemberNotifications(row.preference?.notifications).staff_feedback_email_enabled)
    .map(({ userId, email }) => ({ userId, email }))
}
