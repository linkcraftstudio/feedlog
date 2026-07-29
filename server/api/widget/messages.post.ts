import OpenAI from 'openai'
import { asc, eq } from 'drizzle-orm'
import { board, organizationWidget } from '#layers/feedlog/server/db/schemas'
import { buildWidgetSystemPrompt, parseWidgetAiResponse } from '#layers/feedlog/server/utils/widget-ai'
import { isActorAdmin } from '#layers/feedlog/shared/utils/notifications'
import { getEnabledRuleScenarios } from '#layers/feedlog/shared/utils/widget-settings'

const MAX_COMPLETION_TOKENS = 2048
const MAX_TEXT_LENGTH = 4000
// Mirrors the composer's own ceiling. Every key here becomes a line of markdown
// in the post body, so without a limit the request decides how big a post gets.
const MAX_IMAGES = 3
// One LLM call per message, and a message is a deliberate human act — this only
// has to stop a script, not shape normal use.
const RATE_LIMIT = { limit: 20, windowSeconds: 60 }

interface WidgetMessageResponse {
  type: 'feedback' | 'support' | 'unrecognized'
  reply: string
  post?: {
    id: string
    slug: string
    title: string
    board: string | null
    status: string
  }
}

export default defineEventHandler(async (event): Promise<WidgetMessageResponse> => {
  const { session, orgId } = await requireAuthInOrg(event)

  const ip = getRequestIP(event, { xForwardedFor: true }) || 'unknown'
  if (!await checkRateLimit(`widget-messages:${ip}`, RATE_LIMIT)) {
    throw createError({ statusCode: 429, message: 'Too many messages, try again shortly' })
  }

  const body = await readBody<{ text?: unknown; images?: unknown }>(event).catch(() => null)
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  const images = Array.isArray(body?.images)
    ? body.images.filter((k): k is string => typeof k === 'string' && !!k)
    : []
  if (!text && images.length === 0) {
    throw createError({ statusCode: 422, message: 'Message is empty' })
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw createError({ statusCode: 422, message: 'Message is too long' })
  }
  if (images.length > MAX_IMAGES) {
    throw createError({ statusCode: 422, message: `At most ${MAX_IMAGES} images can be attached` })
  }

  const db = useDB()

  const [widgetRow] = await db
    .select({
      enabled: organizationWidget.enabled,
      supportEmail: organizationWidget.supportEmail,
      disabledBuiltins: organizationWidget.disabledBuiltins,
      customRules: organizationWidget.customRules,
    })
    .from(organizationWidget)
    .where(eq(organizationWidget.orgId, orgId))
    .limit(1)
  // No row = never configured = defaults, which enable the widget.
  if (!(widgetRow?.enabled ?? true)) {
    throw createError({ statusCode: 403, message: 'Widget is not enabled for this organization' })
  }

  const boards = await db
    .select({ id: board.id, name: board.name, description: board.description })
    .from(board)
    .where(eq(board.orgId, orgId))
    .orderBy(asc(board.position))

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw createError({ statusCode: 503, message: 'AI is not configured (OPENAI_API_KEY missing)' })
  }
  const baseURL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const model = process.env.OPENAI_TEXT_MODEL || 'gpt-5.4'

  const orgInfo = event.context.orgSlug ? await getOrgInfo(event.context.orgSlug) : null
  const systemPrompt = buildWidgetSystemPrompt(
    orgInfo?.name || 'this product',
    boards.map(b => ({ name: b.name, description: b.description })),
    getEnabledRuleScenarios(widgetRow ?? null),
  )

  // Images are attached to the post but never sent to the model: extraction is
  // text-only for now, so a screenshot-only message is unrecognized by design.
  let parsed
  try {
    const client = new OpenAI({ apiKey, baseURL })
    const resp = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text || '(no text, image only)' },
      ],
      // Extraction should be reproducible; creative variation only costs accuracy.
      temperature: 0,
      max_completion_tokens: MAX_COMPLETION_TOKENS,
    })
    parsed = parseWidgetAiResponse(resp.choices[0]?.message?.content ?? '')
  }
  catch (err: unknown) {
    // The upstream gateway fronts Azure OpenAI, whose content filter rejects some
    // inputs with a 400. That is permanent — retrying sends the same text — so it
    // degrades to the same dead end as an unusable message rather than the 502
    // the SDK would keep retrying.
    if ((err as { status?: number })?.status === 400) {
      return { type: 'unrecognized', reply: unrecognizedReply() }
    }
    const message = err instanceof Error ? err.message : 'Unknown AI error'
    throw createError({ statusCode: 502, message: `AI extraction failed: ${message}` })
  }

  // A malformed response is a transient model failure — the SDK may retry.
  if (!parsed) {
    throw createError({ statusCode: 502, message: 'AI returned an unusable response' })
  }

  if (parsed.type === 'support') {
    return { type: 'support', reply: supportReply(widgetRow?.supportEmail ?? null) }
  }
  if (parsed.type === 'unrecognized') {
    return { type: 'unrecognized', reply: unrecognizedReply() }
  }

  // The model picks a board by NAME — it cannot reliably copy a uuid. Resolve it
  // here and fall back to the first board so a miss never blocks the post.
  const matched = boards.find(b => b.name.toLowerCase() === parsed.boardName?.toLowerCase())
  const boardRow = matched ?? boards[0] ?? null

  const content = appendImages(parsed.content!, images)
  const created = await createPostRecord({
    orgId,
    authorId: session.user.id,
    title: parsed.title!.slice(0, 200),
    content,
    boardId: boardRow?.id ?? null,
    subscribeAuthor: !isActorAdmin(session, orgId),
  })

  event.waitUntil(
    generatePostEmbedding(created.id, orgId, created.title, content, created.contentHash),
  )

  return {
    type: 'feedback',
    reply: parsed.reply?.trim() || 'Thanks — I turned that into a feedback post for you.',
    post: {
      id: created.id,
      slug: created.slug,
      title: created.title,
      board: boardRow?.name ?? null,
      status: created.status,
    },
  }
})

// Server-composed so the mailto and the wording can't drift with the model. With
// no support email configured the user is still pointed at support, just without
// an address — per the requirement.
function supportReply(supportEmail: string | null): string {
  return supportEmail
    ? `This one is better handled by our support team — please email [${supportEmail}](mailto:${supportEmail}) and they'll take care of it.`
    : 'This one is better handled by our support team — please reach out to them directly and they\'ll take care of it.'
}

function unrecognizedReply(): string {
  return 'I can only help with product feedback — bugs, ideas, or improvement requests. Could you describe what you\'d like to see changed?'
}

// Attachment keys use the attachment: protocol so the renderer resolves them
// through /api/files (see app/utils/attachment.ts).
function appendImages(content: string, images: string[]): string {
  if (images.length === 0) return content
  return `${content}\n\n${images.map(k => `![](attachment:${k})`).join('\n')}`
}
