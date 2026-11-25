import type { PoolClient } from 'pg'
import type { SystemEventPart } from '../../shared/inbox/state'

// A conversation event that changes who owns the conversation. Deployments
// that meter AI work (SaaS billing) must observe each one exactly when the
// business write commits, so the handler runs inside that same transaction.
export interface ConversationEvent {
  orgId: string
  conversationId: string
  kind: 'handoff' | 'takeover' | 'closed'
  reason?: SystemEventPart['reason']
  occurredAt: Date
}

// `client` is the business transaction (pg PoolClient, inside BEGIN). The
// handler may write through it; its writes commit or roll back with the event.
export type ConversationEventHandler = (client: PoolClient, event: ConversationEvent) => Promise<void>

let _handler: ConversationEventHandler | null = null

export function registerConversationEventHandler(handler: ConversationEventHandler): void {
  _handler = handler
}

// A handler failure must never block handoff or closing: the savepoint discards
// only the handler's writes and the conversation change still commits.
export async function emitConversationEvent(client: PoolClient, event: ConversationEvent): Promise<void> {
  if (!_handler) return
  await client.query('SAVEPOINT conversation_event')
  try {
    await _handler(client, event)
    await client.query('RELEASE SAVEPOINT conversation_event')
  }
  catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT conversation_event')
    await client.query('RELEASE SAVEPOINT conversation_event')
    console.warn('[inbox] Conversation event handler failed', { conversationId: event.conversationId, kind: event.kind, error: (error as Error)?.message })
  }
}
