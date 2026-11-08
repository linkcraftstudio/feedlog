import { boardOverview } from '../../services/boards'
import { parseStatusParam } from '#layers/feedlog/shared/types/post'

export default defineEventHandler(event => boardOverview(
  { db: useDB(), orgId: event.context.orgId! },
  parseStatusParam(getQuery(event).status),
))
