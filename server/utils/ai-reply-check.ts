export interface AiReplyRequest {
  orgId: string
  conversationId: string
}

// Resolves null to let the AI reply, or a code (lowercase, e.g. `usage_limit`)
// to pause it: the conversation is then handed to the team with reason `ai_paused`
// and the code as the event's `detail`, which staff see and the customer does not.
export type AiReplyCheck = (request: AiReplyRequest) => Promise<string | null>

let _check: AiReplyCheck | null = null

export function registerAiReplyCheck(check: AiReplyCheck): void {
  _check = check
}

// A failing check must not take the widget down with it, so errors allow the reply.
export async function aiPauseCode(request: AiReplyRequest): Promise<string | null> {
  if (!_check) return null
  try {
    return await _check(request)
  }
  catch (error) {
    console.warn('[agent] AI reply check failed; allowing reply', { conversationId: request.conversationId, error: (error as Error)?.message })
    return null
  }
}
