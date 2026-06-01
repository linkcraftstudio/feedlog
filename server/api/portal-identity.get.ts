import { DEFAULT_ORG_NAME, DEFAULT_ORG_SLUG } from '#layers/feedlog/shared/constants/default-org'

// Public portal identity for share-card meta: org display name + isDefault.
// The unconfigured default org maps to the FeedLog brand; usePageOg turns the
// two cases into the personalized vs generic copy variants.
export default defineEventHandler(async (event): Promise<{ name: string; isDefault: boolean }> => {
  const slug = event.context.orgSlug ?? DEFAULT_ORG_SLUG
  const info = await getOrgInfo(slug)
  const rawName = info?.name ?? DEFAULT_ORG_NAME
  const isDefault = rawName === DEFAULT_ORG_NAME
  return {
    name: isDefault ? 'FeedLog' : rawName,
    isDefault,
  }
})
