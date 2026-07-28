import { eq } from 'drizzle-orm'
import { getRequestURL } from 'h3'
import { uuidv7 } from 'uuidv7'
import { organizationWidget } from '#layers/feedlog/server/db/schemas'
import type { WidgetCustomRule } from '#layers/feedlog/shared/constants/widget-rules'
import { checkEnabledRuleCap, updateWidgetSettingsSchema } from '#layers/feedlog/shared/schemas/widget'
import { resolveWidgetSettings } from '#layers/feedlog/shared/utils/widget-settings'
import type { ResolvedWidgetSettings } from '#layers/feedlog/shared/utils/widget-settings'

// PATCH /api/admin/widget — update widget settings (feedlog:moderate).
export default defineEventHandler(async (event): Promise<ResolvedWidgetSettings & { baseUrl: string }> => {
  const { orgId } = await requireOrgPermission(event, { feedlog: ['moderate'] })
  const body = await readValidatedBody(event, updateWidgetSettingsSchema.parse)

  const db = useDB()
  const [existing] = await db
    .select({
      enabled: organizationWidget.enabled,
      supportEmail: organizationWidget.supportEmail,
      disabledBuiltins: organizationWidget.disabledBuiltins,
      customRules: organizationWidget.customRules,
    })
    .from(organizationWidget)
    .where(eq(organizationWidget.orgId, orgId))
    .limit(1)

  // Merge against the stored row (or the defaults a missing row stands for), so
  // a partial update keeps the untouched halves — and so the rule cap is checked
  // against what the org will actually end up with.
  const merged = {
    enabled: body.enabled ?? existing?.enabled ?? true,
    supportEmail: body.supportEmail !== undefined
      ? (body.supportEmail || null)
      : (existing?.supportEmail ?? null),
    disabledBuiltins: body.disabledBuiltins ?? existing?.disabledBuiltins ?? [],
    customRules: (body.customRules ?? existing?.customRules ?? []).map(r => ({
      // A rule the admin just added arrives without an id.
      id: r.id || `c_${uuidv7()}`,
      scenario: r.scenario,
      enabled: r.enabled,
    })) as WidgetCustomRule[],
  }

  const capError = checkEnabledRuleCap(merged.disabledBuiltins, merged.customRules)
  if (capError) {
    throw createError({ statusCode: 400, message: capError })
  }

  // Lazy creation: the row appears on the first save, so this is an upsert.
  const [saved] = await db
    .insert(organizationWidget)
    .values({ orgId, ...merged })
    .onConflictDoUpdate({ target: organizationWidget.orgId, set: merged })
    .returning()

  return {
    ...resolveWidgetSettings(saved ?? merged),
    baseUrl: getRequestURL(event).origin,
  }
})
