import { z } from 'zod'
import { customerContent } from '../agent/content'
import { inboxStatus } from './state'

const command = { requestId: z.uuid(), expectedLastSeq: z.number().int().nonnegative().safe() }
export const replyInput = z
  .object({ ...command, content: customerContent, notifyByEmail: z.boolean().optional() })
  .strict()
export const actionInput = z.discriminatedUnion('action', [
  z.object({ ...command, action: z.literal('takeover') }).strict(),
  z.object({ ...command, action: z.literal('close') }).strict(),
  z.object({ ...command, action: z.literal('resume') }).strict(),
  z
    .object({
      ...command,
      action: z.literal('snooze'),
      wakeAt: z.iso.datetime(),
      timeZone: z
        .string()
        .max(100)
        .refine((value) => {
          try {
            new Intl.DateTimeFormat('en', { timeZone: value })
            return true
          } catch {
            return false
          }
        }),
    })
    .strict(),
  z.object({ ...command, action: z.literal('set_priority'), priority: z.enum(['normal', 'high']) }).strict(),
])
export type StaffCommand = z.infer<typeof actionInput> | (z.infer<typeof replyInput> & { action: 'reply' })
export const pageInput = z
  .object({
    beforeSeq: z.coerce.number().int().positive().safe().optional(),
    afterSeq: z.coerce.number().int().nonnegative().safe().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine((input) => input.beforeSeq === undefined || input.afterSeq === undefined)
export const listInput = z.object({
  status: z.union([inboxStatus, z.literal('all')]).default('open'),
  priority: z.enum(['all', 'normal', 'high']).default('all'),
  q: z.string().trim().max(200).default(''),
  sort: z.enum(['newest', 'oldest']).default('newest'),
  cursor: z.string().max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})
