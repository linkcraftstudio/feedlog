import { webSourceDiscovery } from '#layers/feedlog/shared/schemas/web-source'
import { discoverWebSourcePages } from '#layers/feedlog/server/lib/web-source/discovery'
import { logWebSourceFailure, publicWebSourceError } from '#layers/feedlog/server/lib/web-source/failure'
export default defineEventHandler(async event => {
  const { orgId } = await requireOrgPermission(event, { feedlog: ['moderate'] })
  if (!await checkRateLimit(`web-source-discovery:${orgId}`, { limit: 10, windowSeconds: 60 })) throw createError({ statusCode: 429, message: 'Too many discovery requests', data: { code: 'rate_limited' } })
  const input = await readValidatedBody(event, webSourceDiscovery.parse)
  try { return await discoverWebSourcePages(input) }
  catch (error) {
    logWebSourceFailure(error, { stage: 'discovery', orgId })
    throw publicWebSourceError(error)
  }
})
