import { z } from 'zod'
import { requestSchedule } from './platform'
import { defineEventHandler, getRouterParam, setResponseHeader, type H3Event } from 'h3'
import { agentRuntime, withAgentRuntime, agentError, type AgentRuntime } from '../agent/runtime'

export function parseInbox<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) agentError(422, 'invalid_input', 'Invalid request parameters')
  return parsed.data
}
export function inboxRoute<T>(
  handler: (context: {
    event: H3Event
    runtime: AgentRuntime
    orgId: string
    userId: string
    id: string
  }) => Promise<T>,
) {
  return defineEventHandler((event) =>
    withAgentRuntime(event, async () => {
      const { orgId, session } = await requireOrgPermission(event, { feedlog: ['inbox'] })
      const parameter = getRouterParam(event, 'id')
      const id = parameter ? parseInbox(z.uuid(), parameter) : ''
      setResponseHeader(event, 'Cache-Control', 'no-store')
      const result = await handler({ event, runtime: agentRuntime(event), orgId, userId: session.user.id, id })
      if (event.method === 'POST') await requestSchedule(event)
      return result
    }),
  )
}
