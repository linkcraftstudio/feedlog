import { eq } from 'drizzle-orm'
import { organizationWidget } from '#layers/feedlog/server/db/schemas'
import { pickBrandForegroundHex, resolveBranding } from '#layers/feedlog/shared/utils/branding'

// GET /api/widget/config — anonymous bootstrap for the widget SDK.
export default defineEventHandler(async (event): Promise<{
  enabled: boolean
  branding: { primary: string; primaryForeground: string }
}> => {
  const slug = event.context.orgSlug
  const info = slug ? await getOrgInfo(slug) : null

  // Branding rides the org cache, but `enabled` is read fresh from its own
  // table: it is the kill switch, and a 30-minute stale read would keep a
  // broken widget live on every customer site.
  let enabled = false
  if (info) {
    const [row] = await useDB()
      .select({ enabled: organizationWidget.enabled })
      .from(organizationWidget)
      .where(eq(organizationWidget.orgId, info.id))
      .limit(1)
    // No row = never configured = defaults, which enable the widget.
    enabled = row?.enabled ?? true
  }

  const branding = resolveBranding(info?.metadata)

  // Both colors are final values — the SDK does no color math, so a light brand
  // must arrive with a dark foreground already picked.
  setResponseHeader(event, 'Cache-Control', 'public, max-age=60')
  return {
    enabled,
    branding: {
      primary: branding.primaryColor,
      primaryForeground: pickBrandForegroundHex(branding.primaryColor),
    },
  }
})
