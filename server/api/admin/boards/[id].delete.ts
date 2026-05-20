import { and, eq } from 'drizzle-orm'
import { board, post } from '#layers/feedlog/server/db/schemas'

// DELETE /api/boards/:id — Delete board (feedlog:moderate); clears post.board_id.
export default defineEventHandler(async (event) => {
  const { orgId } = await requireOrgPermission(event, { feedlog: ['moderate'] })

  const id = getRouterParam(event, 'id')!
  const db = useDB()

  // Clear board_id on this org's posts that were attached to the board.
  await db.update(post).set({ boardId: null }).where(and(eq(post.boardId, id), eq(post.orgId, orgId)))

  const [deleted] = await db.delete(board).where(and(eq(board.id, id), eq(board.orgId, orgId))).returning({ id: board.id })

  if (!deleted) {
    throw createError({ statusCode: 404, message: 'Board not found' })
  }

  setResponseStatus(event, 204)
  return null
})
