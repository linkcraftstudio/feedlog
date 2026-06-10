import { DEFAULT_ORG_NAME, DEFAULT_ORG_SLUG } from '#layers/feedlog/shared/constants/default-org'
import type { ResolvedBranding } from '#layers/feedlog/shared/utils/branding'
import { resolveBranding } from '#layers/feedlog/shared/utils/branding'

function resolveLogoUrl(logo: string | null | undefined): string | null {
  if (!logo) return null
  if (logo.startsWith('http') || logo.startsWith('/')) return logo
  return `/api/files/${logo}`
}

// Public portal identity for share-card meta and first-paint branding.
// The unconfigured default org maps to the FeedLog brand; usePageOg turns the
// two cases into the personalized vs generic copy variants.
export default defineEventHandler(async (event): Promise<{
  name: string
  logo: string | null
  isDefault: boolean
  branding: ResolvedBranding
}> => {
  const slug = event.context.orgSlug ?? DEFAULT_ORG_SLUG
  const info = await getOrgInfo(slug)
  const rawName = info?.name ?? DEFAULT_ORG_NAME
  const isDefault = rawName === DEFAULT_ORG_NAME
  return {
    name: isDefault ? 'FeedLog' : rawName,
    logo: resolveLogoUrl(info?.logo),
    isDefault,
    branding: resolveBranding(info?.metadata),
  }
})
