import { z } from 'zod'
import { webSourceFailureCode } from '#layers/feedlog/shared/utils/web-source-failure'
import { readWebSourcePage } from '#layers/feedlog/server/services/web-source'
import { webSourceRequest } from '#layers/feedlog/server/lib/web-source/http'
export default defineEventHandler(async event => {
  const { orgId } = await requireOrgMember(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.uuid() }).parse)
  return webSourceRequest(event, async pool => {
    const page = await readWebSourcePage(pool, orgId, id)
    return { ...page, error: page.error ? webSourceFailureCode(page.error) : null }
  })
})
