import { getFeedbackDetail } from '#layers/feedlog/server/services/feedback-web-queries'

export default defineEventHandler(async (event): Promise<PostDetail> => {
  const session = await getUserSession(event)
  const orgId = event.context.orgId!
  const slug = getRouterParam(event, 'postId')!

  setResponseHeader(event, 'Cache-Control', 'private, no-store')
  return getFeedbackDetail({ db: useDB(), orgId }, slug, session?.user.id, await getOrgMemberRole(session, orgId))
})
