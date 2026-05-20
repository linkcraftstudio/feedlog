// Injects { orgId, orgSlug } into event.context for every request, so
// handlers can scope queries by org without re-resolving it. A null
// resolver result means "no tenant binding" — skip setting context.orgId
// so unauthenticated routes (/register, /login, /api/auth/*) aren't
// blocked by handlers that require an org.
export default defineEventHandler(async (event) => {
  const ctx = await resolveOrgContext(event)
  if (!ctx) return
  event.context.orgId = ctx.orgId
  event.context.orgSlug = ctx.orgSlug
})
