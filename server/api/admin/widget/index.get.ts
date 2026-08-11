import { eq } from 'drizzle-orm'
import { getRequestURL } from 'h3'
import { organizationWidget } from '#layers/feedlog/server/db/schemas'
import { resolveWidgetSettings } from '#layers/feedlog/shared/utils/widget-settings'
import type { ResolvedWidgetSettings } from '#layers/feedlog/shared/utils/widget-settings'

// GET /api/admin/widget — widget settings for the admin page (feedlog:moderate).
export default defineEventHandler(async (event): Promise<ResolvedWidgetSettings & { baseUrl: string }> => {
  const { orgId } = await requireOrgPermission(event, { feedlog: ['moderate'] })

  const [row] = await useDB()
    .select({
      enabled: organizationWidget.enabled,
      supportEmail: organizationWidget.supportEmail,
      disabledBuiltins: organizationWidget.disabledBuiltins,
      customRules: organizationWidget.customRules,
      conversationRetentionDays: organizationWidget.conversationRetentionDays,
    })
    .from(organizationWidget)
    .where(eq(organizationWidget.orgId, orgId))
    .limit(1)

  return {
    // Resolves built-in rules from code and fills defaults when no row exists.
    ...resolveWidgetSettings(row ?? null),
    // Derived from the host serving this dashboard, so the integrator always
    // copies a working value.
    baseUrl: getRequestURL(event).origin,
  }
})
