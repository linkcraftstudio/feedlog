import { z } from 'zod'

export const inboxStatus = z.enum(['ai_handling', 'open', 'pending', 'snoozed', 'closed'])
export type InboxStatus = z.infer<typeof inboxStatus>
export const handoffReason = z.enum([
  'user_requested',
  'knowledge_gap',
  'sensitive_or_permission',
  'dissatisfied',
  'support_rule',
])
export type HandoffReason = z.infer<typeof handoffReason> | 'ai_error'
export const handoffRule = z.object({
  id: z.string().min(1),
  scenario: z.string().min(1),
  scenarioZh: z.string().min(1).optional(),
}).strict()
export type HandoffRule = z.infer<typeof handoffRule>
export const handoffCustomerNotice = z.string().trim().min(1).max(1000)
export const systemEventPart = z
  .object({
    type: z.literal('system_event'),
    kind: z.enum(['handoff', 'takeover_requested', 'takeover', 'reopened', 'customer_resumed', 'priority_changed', 'snoozed', 'resumed', 'closed']),
    reason: z.enum([...handoffReason.options, 'ai_error', 'manual', 'timeout', 'customer_message']),
    fromStatus: inboxStatus,
    toStatus: inboxStatus,
    runId: z.uuid().optional(),
    rule: handoffRule.optional(),
    customerNotice: handoffCustomerNotice.optional(),
    dueAt: z.iso.datetime().optional(),
    fromPriority: z.enum(['normal', 'high']).optional(),
    toPriority: z.enum(['normal', 'high']).optional(),
  })
  .strict()
export type SystemEventPart = z.infer<typeof systemEventPart>
export function handling(status: InboxStatus): 'ai' | 'human' | 'closed' {
  return status === 'ai_handling' ? 'ai' : status === 'closed' ? 'closed' : 'human'
}
export const HANDOFF_NOTICES = {
  handoffBilling: 'This issue requires our support team to review your account or billing. It has been passed to them. You can add more details here.',
  handoffAccount: 'This issue requires our support team to review your account. It has been passed to them. You can add more details here.',
  handoffPrivacy: 'This request requires our support team to handle it. It has been passed to them. You can add more details about your request here.',
  handoffRule: 'This issue requires further assistance from our support team. It has been passed to them. You can add more details here.',
  handoff: "Your question has been passed to our support team. You can send more details or screenshots here.",
} as const
export type HandoffNotice = keyof typeof HANDOFF_NOTICES
export function handoffNotice(reason: string, ruleId?: string): HandoffNotice {
  if (reason !== 'support_rule') return 'handoff'
  switch (ruleId) {
    case 'builtin-billing': return 'handoffBilling'
    case 'builtin-account-access': return 'handoffAccount'
    case 'builtin-privacy-legal': return 'handoffPrivacy'
    default: return 'handoffRule'
  }
}

export const HANDOFF_NOTICE = HANDOFF_NOTICES.handoff
