import { z } from 'zod'
import { systemEventPart, type HandoffNotice } from '../inbox/state'
import { CHAT_IMAGE_MAX_COUNT } from './images'

export const textPart = z.object({ type: z.literal('text'), text: z.string().min(1).refine(value => !!value.trim()) }).strict()
export const imagePart = z.object({ type: z.literal('image'), storage_key: z.string().min(1).max(1000) }).strict()
const feedbackFields = {
  feedback_id: z.uuid(), slug: z.string().min(1), title: z.string().min(1),
  board_id: z.uuid().nullable(), board_name: z.string(), status_id: z.string().nullable(),
  vote_count: z.number().int().nonnegative(), has_voted: z.boolean(),
}
const commentFields = { ...feedbackFields, comment_id: z.uuid(), comment_text: z.string().min(1) }
export const contentPart = z.discriminatedUnion('type', [
  systemEventPart,
  textPart, imagePart,
  z.object({ type: z.literal('article_reference'), articles: z.array(z.object({ article_id: z.uuid(), slug: z.string().min(1), title: z.string().min(1) })).min(1) }),
  ...(['feedback_created', 'feedback_updated', 'feedback_upvoted'] as const).map(type => z.object({ type: z.literal(type), ...feedbackFields })),
  ...(['feedback_comment_added', 'feedback_comment_updated'] as const).map(type => z.object({ type: z.literal(type), ...commentFields })),
])
export const contentSchema = z.object({ parts: z.array(contentPart).min(1) })
export const customerContent = z.object({ parts: z.array(z.discriminatedUnion('type', [textPart, imagePart])).min(1).max(CHAT_IMAGE_MAX_COUNT + 1) }).strict().refine(
  value => value.parts.reduce((sum, part) => sum + (part.type === 'text' ? part.text.length : 0), 0) <= 4000,
  'Message text must not exceed 4000 characters',
).refine(
  value => value.parts.filter(part => part.type === 'image').length <= CHAT_IMAGE_MAX_COUNT,
  `A message can contain up to ${CHAT_IMAGE_MAX_COUNT} images`,
)
export const pageContext = z.object({
  origin: z.string().max(2000).refine(value => {
    try {
      const url = new URL(value)
      return ['http:', 'https:'].includes(url.protocol) && url.origin === value
    } catch { return false }
  }),
  pathname: z.string().max(2000).refine(value => /^\/(?!\/)/.test(value) && !/[?#\\]/.test(value)),
  title: z.string().max(500).optional(), description: z.string().max(2000).optional(),
}).strict().partial()
export const chatInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('send'), idempotency_key: z.string().min(1).max(100), message: z.object({ id: z.string().min(1).max(100), content: customerContent, context: pageContext.nullish().transform(value => value ?? null) }).strict() }).strict(),
  z.object({ action: z.literal('retry'), idempotency_key: z.string().min(1).max(100), trigger_item_id: z.string().min(1).max(100) }).strict(),
])
export type Content = z.infer<typeof contentSchema>
export type Part = Content['parts'][number]
export type FeedbackPart = Extract<Part, { feedback_id: string }>
export type PageContext = z.infer<typeof pageContext>
export type ChatInput = z.infer<typeof chatInput>
export interface Item { author?: { name: string | null } | null; notice?: 'handoff' | 'closed' | 'reopened'; handoffNotice?: HandoffNotice; customerNotice?: string; id: string; seq: number; authorType: 'customer' | 'agent' | 'staff' | 'system'; content: Content; context: PageContext | null; agentRunId: string | null; createdAt: string }
export interface Run { id: string; triggerItemId: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; error: string | null; startedAt: string; deadlineAt: string; finishedAt: string | null }
export interface Conversation { id: string; title: string | null; lastSeq: number; unread: boolean; handling?: 'ai' | 'human' | 'closed' }
export interface Detail { conversation: Conversation; items: Item[]; runs: Run[]; nextBeforeSeq: number | null; nextAfterSeq?: number; hasMore?: boolean }
export type StreamEvent = { type: 'run'; runId: string } | { type: 'text'; delta: string } | { type: 'tool'; runId: string; callId: string; name: string; phase: 'start' | 'finish'; data: unknown; durationMs?: number } | { type: 'finish'; runId: string } | { type: 'error'; message: string }
