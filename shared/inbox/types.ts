import type { Item } from '../agent/content'
import type { InboxStatus } from './state'
export interface InboxConversation {
  id: string
  title: string | null
  previewText: string | null
  status: InboxStatus
  takeoverPending?: boolean
  priority: 'normal' | 'high'
  stateDueAt: string | null
  lastMessageAt: string
  lastSeq: number
}
export interface InboxCustomer {
  id: string
  name: string | null
  image: string | null
  isAnonymous: boolean
  email?: string | null
}
export interface InboxMessage extends Item {
  author: { id: string; name: string | null; image: string | null; isAnonymous: boolean } | null
}
export interface InboxDetail {
  conversation: InboxConversation
  customer: InboxCustomer
  items: InboxMessage[]
  nextBeforeSeq: number | null
  nextAfterSeq: number
  hasMore: boolean
  emails: Record<string, EmailResult>
}
export interface EmailResult {
  deliveryMode?: 'auto' | 'immediate'
  status: 'pending' | 'skipped' | 'accepted' | 'failed' | 'unavailable'
  canRetry: boolean
}
export interface InboxCommandResult {
  requestId: string
  replayed: boolean
  item: { id: string; seq: number; createdAt: string }
  conversation: InboxConversation
  email?: EmailResult | null
}
