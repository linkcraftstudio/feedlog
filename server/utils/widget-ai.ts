// Prompt and response parsing for the widget's feedback extraction. The prompt
// below is the version validated in the model evaluation: an earlier draft
// phrased handoff rules as topics ("user asks about billing…"), which made the
// model redirect any message merely containing the word. Phrasing them as the
// user SEEKING HELP, plus the decision order and the contrast examples, is what
// fixed it — keep all three when editing.

export type WidgetAiType = 'feedback' | 'support' | 'clarify' | 'unrecognized'

export interface WidgetAiOutput {
  type: WidgetAiType
  reply?: string
  title?: string
  content?: string
  boardName?: string
}

export interface WidgetPromptBoard {
  name: string
  description: string | null
}

export interface WidgetHistoryTurn {
  role: 'user' | 'assistant'
  text: string
  type?: WidgetAiType
  postTitle?: string
}

const AI_TYPES = new Set<string>(['feedback', 'support', 'clarify', 'unrecognized'])
const HISTORY_TITLE_MAX = 200

// The client owns this array, so only its shape survives: unknown fields are
// dropped and an unrecognized "type" is omitted rather than replayed into the
// prompt. null = not a list of well-formed turns.
export function parseWidgetHistory(raw: unknown): WidgetHistoryTurn[] | null {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) return null

  const turns: WidgetHistoryTurn[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null
    const o = item as Record<string, unknown>
    if (o.role !== 'user' && o.role !== 'assistant') return null
    if (typeof o.text !== 'string') return null

    const turn: WidgetHistoryTurn = { role: o.role, text: o.text }
    if (o.role === 'assistant') {
      if (typeof o.type === 'string' && AI_TYPES.has(o.type)) turn.type = o.type as WidgetAiType
      if (typeof o.postTitle === 'string' && o.postTitle) turn.postTitle = o.postTitle.slice(0, HISTORY_TITLE_MAX)
    }
    turns.push(turn)
  }
  return turns
}

// Assistant turns replay as the JSON the model itself returned, minus content —
// that is what makes "this one is already filed" legible on the next call.
export function historyToMessages(history: WidgetHistoryTurn[]): { role: 'user' | 'assistant', content: string }[] {
  return history.map((turn) => {
    if (turn.role === 'user') {
      return { role: 'user' as const, content: turn.text || '(no text, image only)' }
    }
    const payload: Record<string, string> = {}
    if (turn.type) payload.type = turn.type
    if (turn.postTitle) payload.title = turn.postTitle
    payload.reply = turn.text
    return { role: 'assistant' as const, content: JSON.stringify(payload) }
  })
}

export function buildWidgetSystemPrompt(
  productName: string,
  boards: WidgetPromptBoard[],
  ruleScenarios: string[],
): string {
  const boardLines = boards.length
    ? boards.map(b => `- "${b.name}"${b.description ? ` — ${b.description}` : ''}`).join('\n')
    : '- (no boards configured)'
  const ruleLines = ruleScenarios.length
    ? ruleScenarios.map(r => `- ${r}`).join('\n')
    : '- (none configured)'

  return `You are the feedback assistant embedded in ${productName}'s in-app widget.
You are an AI assistant, NOT a human support agent — never imply otherwise.
Read the WHOLE conversation and classify the user's latest turn into EXACTLY ONE of four
outcomes.

## What you already did in this conversation
Your earlier turns appear as the JSON you returned. A turn with "type":"feedback" means
that request is ALREADY FILED — never file it again, and never mention filing it again.
Read the WHOLE conversation to understand what the user means (an answer to your own
follow-up only makes sense in context), but judge only their LATEST turn — earlier turns
are context, not new requests. One conversation may legitimately produce several separate
posts, but only for genuinely DIFFERENT requests.

## Workspace boards (pick the best-fitting one when drafting feedback)
${boardLines}

## Redirect-to-support situations (configured by the workspace admin)
ALWAYS redirect to support when the user is actually SEEKING HELP for their own case in one of these:
${ruleLines}

## Decision order (apply top-down, pick the FIRST that matches)
1. "support"      — the user is SEEKING HELP for their own account, data, or money: one of
                    the situations above, or anything else only a human on the team can act
                    on for them. This applies at ANY turn, including mid-clarification.
2. "feedback"     — you can already draft a post the team could act on, AND it is not
                    something you filed earlier in this conversation. Draft it.
3. "clarify"      — the user is repeating or adding detail to something you ALREADY FILED,
                    or they are talking about the product but you cannot draft ANYTHING
                    actionable (no concrete subject, or no concrete ask). Ask ONE short
                    question, or confirm what is already on record. Draft nothing.
4. "unrecognized" — off-topic, empty, or unrelated to the product. Draft nothing.

## CRITICAL — mentioning a topic word is NOT the same as needing support for it
Suggesting a product change that merely CONTAINS a word like "privacy", "billing", "login", or "invoice"
is still FEEDBACK, not support. Judge the user's INTENT, not the vocabulary.
Examples:
- "Add a privacy policy page to the site."        → feedback — a product suggestion, NOT a privacy help request.
- "The billing page layout is confusing to read." → feedback — UX feedback about a page, NOT a charge problem.
- "Add SSO login support please."                 → feedback — a feature, NOT an account-access problem.
- "I was double charged, please refund me."        → support — needs help with a charge on their account.
- "I'm locked out of my account."                  → support — blocked from logging in.
- "Please delete my account."                      → support — an action on their own account only a human can take.

## CRITICAL — an incomplete description is NOT the same as an undraftable one
Prefer "feedback" over "clarify". Choose "clarify" ONLY when you cannot draft ANYTHING
actionable — never merely to collect more detail on something you could already file.
- "The export button spins forever."          → feedback. File it. Do NOT ask which report.
- "Something is wrong with the reports page." → clarify. No concrete symptom to file.
- "This thing is so slow."                    → clarify. No concrete subject to file.
- "Add a dark mode please."                   → feedback. File it.

## CRITICAL — never file the same request twice
If one of your own earlier turns already filed it, do NOT file it again, however the user
phrases it the second time. Repeating it, adding a detail to it, or asking where it stands
are all "clarify": confirm it is on record, then ask whether there is anything else.
Assume you filed "Export button spins forever" earlier:
- "The export still spins."             → clarify. Already filed; say so.
- "It only happens with big files."     → clarify. Same issue, extra detail.
- "Also the dashboard is slow."         → feedback. A genuinely different problem.

## When type = "feedback", also produce
- "title":     a concise, specific one-line summary (<= 80 chars).
- "content":   restate the request faithfully IN THE USER'S OWN VOICE (first person). Do not invent details.
- "boardName": copy EXACTLY one board "name" from the list above that best fits. If none clearly fits, omit.

## Reply text
- type = "feedback": short friendly confirmation in "reply".
- type = "clarify":  the ONE question you are asking, in "reply". Nothing else.
- support/unrecognized: leave "reply" empty.
- Always answer in the SAME language as the user's message.

## Output — return ONLY this JSON, no prose, no code fence:
{ "type": "...", "reply": "...", "title": "...", "content": "...", "boardName": "..." }
Include title / content / boardName ONLY when type = "feedback".`
}

function isValidOutput(obj: unknown): obj is WidgetAiOutput {
  if (!obj || typeof obj !== 'object') return false
  const o = obj as Record<string, unknown>
  if (!AI_TYPES.has(o.type as string)) return false
  // A feedback verdict without a draft is unusable; treat it as malformed so the
  // caller retries or degrades rather than creating an empty post.
  if (o.type === 'feedback' && (typeof o.title !== 'string' || typeof o.content !== 'string')) return false
  // Likewise a follow-up with nothing to ask: an empty bubble, no way forward.
  if (o.type === 'clarify' && (typeof o.reply !== 'string' || !o.reply.trim())) return false
  return true
}

// Same three-layer fallback as the changelog generator: models occasionally wrap
// JSON in prose or a code fence, and a whole request is too expensive to lose to
// formatting. Returns null instead of throwing so the caller can decide.
export function parseWidgetAiResponse(raw: string): WidgetAiOutput | null {
  const attempts: string[] = [raw]

  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (fence?.[1]) attempts.push(fence[1])

  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first !== -1 && last > first) attempts.push(raw.slice(first, last + 1))

  for (const candidate of attempts) {
    try {
      const obj = JSON.parse(candidate)
      if (isValidOutput(obj)) return obj
    }
    catch { /* try next */ }
  }
  return null
}
