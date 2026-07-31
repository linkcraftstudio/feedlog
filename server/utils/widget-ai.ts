// Prompt and response parsing for the widget's feedback extraction. The prompt
// below is the version validated in the model evaluation: an earlier draft
// phrased handoff rules as topics ("user asks about billing…"), which made the
// model redirect any message merely containing the word. Phrasing them as the
// user SEEKING HELP, plus the decision order and the contrast examples, is what
// fixed it — keep all three when editing.

export type WidgetAiType = 'feedback' | 'support' | 'unrecognized'

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
Read the user's latest message and classify it into EXACTLY ONE of three outcomes.

## Workspace boards (pick the best-fitting one when drafting feedback)
${boardLines}

## Redirect-to-support situations (configured by the workspace admin)
ALWAYS redirect to support when the user is actually SEEKING HELP for their own case in one of these:
${ruleLines}

## Decision order (apply top-down, pick the FIRST that matches)
1. "support"      — the user is SEEKING HELP for their own account, data, or money: one of the
                    situations above, or anything else only a human on the team can act on for them.
2. "feedback"     — a concrete, publicly-postable product idea, bug, or improvement request. Draft it.
3. "unrecognized" — unclear, off-topic, empty, or unrelated to the product. Draft nothing.

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

## When type = "feedback", also produce
- "title":     a concise, specific one-line summary (<= 80 chars).
- "content":   restate the request faithfully IN THE USER'S OWN VOICE (first person). Do not invent details.
- "boardName": copy EXACTLY one board "name" from the list above that best fits. If none clearly fits, omit.

## Reply text
- type = "feedback": short friendly confirmation in "reply". support/unrecognized: leave "reply" empty.
- Always answer in the SAME language as the user's message.

## Output — return ONLY this JSON, no prose, no code fence:
{ "type": "...", "reply": "...", "title": "...", "content": "...", "boardName": "..." }
Include title / content / boardName ONLY when type = "feedback".`
}

function isValidOutput(obj: unknown): obj is WidgetAiOutput {
  if (!obj || typeof obj !== 'object') return false
  const o = obj as Record<string, unknown>
  if (o.type !== 'feedback' && o.type !== 'support' && o.type !== 'unrecognized') return false
  // A feedback verdict without a draft is unusable; treat it as malformed so the
  // caller retries or degrades rather than creating an empty post.
  if (o.type === 'feedback' && (typeof o.title !== 'string' || typeof o.content !== 'string')) return false
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
