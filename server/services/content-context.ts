import { and, eq } from 'drizzle-orm'
import { createError, getRequestURL, type H3Event } from 'h3'
import { db } from '../db'
import { member } from '../db/schemas'

export type ContentDatabase = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete' | 'execute' | 'transaction'>
export type ContentReader = Pick<ContentContext, 'db' | 'orgId'>
export interface ContentContext {
  db: ContentDatabase
  orgId: string
  userId: string
  role: string | null
  origin: string
  afterCommit: Array<() => void | Promise<void>>
  event: H3Event
}
export function contentError(statusCode: number, message: string) {
  const code = statusCode === 403 ? 'FORBIDDEN' : statusCode === 404 ? 'NOT_FOUND' : 'INVALID_ARGUMENT'
  return createError({ statusCode, message, data: { code } })
}
export function isModerator(context: ContentContext) {
  return ['owner', 'manager'].includes(context.role ?? '')
}
export function requireModerator(context: ContentContext) {
  if (!isModerator(context)) throw contentError(403, 'Organization administrator access is required')
}
export function runAfterCommit(context: Pick<ContentContext, 'event' | 'afterCommit'>) {
  for (const task of context.afterCommit) {
    context.event.waitUntil(Promise.resolve().then(task).catch(error => console.error('[content] after-commit task failed', error)))
  }
}
export async function contentTransaction<T>(event: H3Event, orgId: string, userId: string, operation: (context: ContentContext) => Promise<T>) {
  const afterCommit: ContentContext['afterCommit'] = []
  const result = await db.transaction(async tx => {
    const [membership] = await tx.select().from(member).where(and(eq(member.userId, userId), eq(member.organizationId, orgId))).for('share')
    return operation({ db: tx, orgId, userId, role: membership && !membership.suspendedAt ? membership.role : null, origin: getRequestURL(event).origin, event, afterCommit })
  })
  runAfterCommit({ event, afterCommit })
  return result
}
