import { cursorPage, type CursorPageInput } from './query-pagination'
import { postFilterConditions } from '../utils/postFilterConditions'
import { and, asc, eq, sql } from 'drizzle-orm'
import type { z } from 'zod'
import { board, post } from '../db/schemas'
import { createBoardSchema, updateBoardSchema } from '../../shared/schemas/board'
import { contentError, requireModerator, type ContentReader, type ContentContext } from './content-context'
import { lockFeedback } from './feedback-lock'

export async function createBoard(context: ContentContext, body: z.infer<typeof createBoardSchema>) {
  requireModerator(context)
  const input = createBoardSchema.parse(body)
  const [last] = await context.db.select({ position: sql<number>`coalesce(max(${board.position}), -1)::int` }).from(board).where(eq(board.orgId, context.orgId))
  const [record] = await context.db.insert(board).values({ ...input, orgId: context.orgId, position: (last?.position ?? -1) + 1 }).returning()
  return record!
}
export async function updateBoard(context: ContentContext, id: string, body: z.infer<typeof updateBoardSchema>) {
  requireModerator(context)
  const input = updateBoardSchema.parse(body)
  if (!Object.values(input).some(value => value !== undefined)) throw contentError(400, 'No fields to update')
  const [record] = await context.db.update(board).set(input).where(and(eq(board.id, id), eq(board.orgId, context.orgId))).returning()
  if (!record) throw contentError(404, 'Board not found')
  return record
}
export async function deleteBoard(context: ContentContext, id: string) {
  requireModerator(context)
  await lockFeedback(context)
  const [record] = await context.db.select().from(board).where(and(eq(board.id, id), eq(board.orgId, context.orgId))).for('update')
  if (!record) throw contentError(404, 'Board not found')
  await context.db.update(post).set({ boardId: null }).where(and(eq(post.boardId, id), eq(post.orgId, context.orgId)))
  await context.db.delete(board).where(eq(board.id, id))
  return { id, deleted: true }
}

export const boardFields = {
  id: board.id, orgId: board.orgId, name: board.name, description: board.description,
  position: board.position, createdAt: board.createdAt, updatedAt: board.updatedAt,
}
// Both dashboard counts and paginated board summaries exclude merged children.
const boardFeedbackCount = sql<number>`count(${post.id})::int`
export async function listBoards(context: ContentReader, input?: CursorPageInput, statuses?: string[]) {
  const scope = { kind: 'boards', organizationId: context.orgId, filter: statuses?.length ? { status: statuses } : {}, sort: 'position', ascending: true }
  const page = input ? await cursorPage(input, scope, board.position, board.id, true, true) : undefined
  const query = context.db.select({ ...boardFields, feedbackCount: boardFeedbackCount, cursorKey: board.position }).from(board)
    .leftJoin(post, and(eq(post.boardId, board.id), ...postFilterConditions({ orgId: context.orgId, status: statuses })))
    .where(and(eq(board.orgId, context.orgId), page?.after)).groupBy(board.id).orderBy(asc(board.position), asc(board.id))
  const rows = await (input ? query.limit(input.limit + 1) : query)
  return page ? page.finish(rows) : { items: rows.map(({ cursorKey: _key, ...row }) => row), nextCursor: null }
}
export async function boardOverview(context: ContentReader, statuses?: string[]) {
  const [page, totals] = await Promise.all([
    listBoards(context, undefined, statuses),
    context.db.select({ count: sql<number>`count(*)::int` }).from(post).where(and(...postFilterConditions({ orgId: context.orgId, status: statuses }))),
  ])
  return {
    data: page.items.map(({ id, name, description, position, feedbackCount, createdAt }) => ({ id, name, description, position, postCount: feedbackCount, createdAt })),
    totalPostCount: totals[0]?.count ?? 0,
  }
}
