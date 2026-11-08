import { z } from 'zod/v4'
import { chatInput } from '#layers/feedlog/shared/agent/content'

const chatResumeSchema = z.object({
  conversationId: z.string().nullable(),
  draft: z.string().max(4000),
  pending: chatInput.nullable().default(null),
  articleSlug: z.string().nullable().default(null),
  articleScrollTop: z.number().finite().nonnegative().default(0),
  firstSeq: z.number().int().positive().nullable().default(null),
  attachments: z.array(z.object({ key: z.string(), name: z.string(), bytes: z.number().int().positive().optional() })),
  scrollTop: z.number().finite().nonnegative(),
})

export const widgetResumeSchema = z.object({
  owner: z.string().nullable(),
  anonymous: z.boolean(),
  view: z.enum(['conversations', 'chat', 'list']),
  conversationId: z.string().nullable(),
  chat: chatResumeSchema.nullable(),
  scrollTop: z.number().finite().nonnegative(),
})

export type WidgetChatResume = z.infer<typeof chatResumeSchema>
