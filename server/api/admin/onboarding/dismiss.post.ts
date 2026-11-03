import { clearOnboardingAutoOpen } from '#layers/feedlog/server/lib/onboarding/seed'

// POST /api/admin/onboarding/dismiss — the user closed the guide; stop opening it
// automatically. A no-op for anyone the marker is not addressed to.
export default defineEventHandler(async (event): Promise<{ cleared: boolean }> => {
  const { session, orgId } = await requireOrgPermission(event, { feedlog: ['moderate'] })
  return { cleared: await clearOnboardingAutoOpen(orgId, session.user.id) }
})
