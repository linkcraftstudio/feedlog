import { eq } from 'drizzle-orm'
import { organizationWidget } from '#layers/feedlog/server/db/schemas'
import { pickBrandForegroundHex, resolveBranding } from '#layers/feedlog/shared/utils/branding'
import { resolveGuestAccess } from '#layers/feedlog/shared/utils/guest'

// GET /api/widget/config — anonymous bootstrap for the widget SDK.
export default defineEventHandler(async (event): Promise<{
  enabled: boolean
  allowGuest: boolean
  org: { name: string; logo: string | null }
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

  // Not cached. Every field here is a switch an admin flips expecting it to take
  // effect: `enabled` kills the widget, `allowGuest` decides whether the frame
  // offers a composer at all. A stale read hands a visitor a composer they can no
  // longer post through, and the refusal reaches them as a generic send failure.
  //
  // It buys back less than it looks: the SDK's read and the frame's read land in
  // different browser cache partitions (keyed by top-frame site *and* frame site),
  // so they never shared an entry — a cold visitor always cost two origin hits,
  // cached or not. Only repeat page loads inside the window were saved.
  setResponseHeader(event, 'Cache-Control', 'no-store')

  // Both colors are final values — the SDK does no color math, so a light brand
  // must arrive with a dark foreground already picked.
  return {
    enabled,
    // Everything a visitor can do in the widget ends in a post, so guest posting
    // decides whether the frame shows the composer or a sign-in wall.
    allowGuest: resolveGuestAccess(info?.metadata).allowPost,
    // The frame wears the customer's name and mark, for the same reason it takes
    // their brand colour from here.
    org: { name: info?.name ?? '', logo: info?.logo || null },
    branding: {
      primary: branding.primaryColor,
      primaryForeground: pickBrandForegroundHex(branding.primaryColor),
    },
  }
})
