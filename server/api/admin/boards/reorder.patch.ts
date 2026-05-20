import { and, eq } from 'drizzle-orm'
import { board } from '#layers/feedlog/server/db/schemas'
import { reorderBoardSchema } from '#layers/feedlog/shared/schemas/board'

// PATCH /api/boards/reorder — Reorder boards (feedlog:moderate).
export default defineEventHandler(async (event) => {
  const { orgId } = await requireOrgPermission(event, { feedlog: ['moderate'] })

  const body = await readValidatedBody(event, reorderBoardSchema.parse)

  const db = useDB()
  await Promise.all(
    body.ids.map((id, index) =>
      db.update(board).set({ position: index }).where(and(eq(board.id, id), eq(board.orgId, orgId))),
    ),
  )

  setResponseStatus(event, 204)
  return null
})
