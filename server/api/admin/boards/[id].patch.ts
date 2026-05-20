import { and, eq } from 'drizzle-orm'
import { board } from '#layers/feedlog/server/db/schemas'
import { updateBoardSchema } from '#layers/feedlog/shared/schemas/board'

// PATCH /api/boards/:id — Update board (feedlog:moderate).
export default defineEventHandler(async (event) => {
  const { orgId } = await requireOrgPermission(event, { feedlog: ['moderate'] })

  const id = getRouterParam(event, 'id')!
  const body = await readValidatedBody(event, updateBoardSchema.parse)

  const updates: Record<string, unknown> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.description !== undefined) updates.description = body.description || null

  if (Object.keys(updates).length === 0) {
    throw createError({ statusCode: 400, message: 'No fields to update' })
  }

  const db = useDB()
  const [updated] = await db
    .update(board)
    .set(updates)
    .where(and(eq(board.id, id), eq(board.orgId, orgId)))
    .returning()

  if (!updated) {
    throw createError({ statusCode: 404, message: 'Board not found' })
  }

  return updated
})
