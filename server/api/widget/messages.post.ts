import OpenAI from 'openai'
import { asc, eq } from 'drizzle-orm'
import { getRequestURL } from 'h3'
import { board, conversation, message, organizationWidget } from '#layers/feedlog/server/db/schemas'
import { buildWidgetSystemPrompt, historyToMessages, parseWidgetAiResponse, parseWidgetHistory } from '#layers/feedlog/server/utils/widget-ai'
import { CONVERSATION_TOKEN_BUDGET, estimateTokens, isConversationId, ownedConversation } from '#layers/feedlog/server/utils/conversation'
import type { WidgetAiOutput, WidgetHistoryTurn } from '#layers/feedlog/server/utils/widget-ai'
import type { CreatedPost } from '#layers/feedlog/server/utils/post-create'
import { isActorAdmin } from '#layers/feedlog/shared/utils/notifications'
import { getEnabledRuleScenarios } from '#layers/feedlog/shared/utils/widget-settings'

const MAX_COMPLETION_TOKENS = 2048
const MAX_TEXT_LENGTH = 4000
// One LLM call per message, and a message is a deliberate human act — this only
// has to stop a script, not shape normal use.
const RATE_LIMIT = { limit: 20, windowSeconds: 60 }

interface WidgetMessageResponse {
  conversationId: string
  type: 'feedback' | 'support' | 'clarify' | 'unrecognized'
  reply: string
  conversationTitle?: string
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
  const userId = session.user.id

  if (!await checkRateLimit(`widget-messages:${userId}`, RATE_LIMIT)) {
    throw createError({ statusCode: 429, message: 'Too many messages, try again shortly' })
  }

  const body = await readBody<{
    text?: unknown
    images?: unknown
    conversationId?: unknown
    history?: unknown
  }>(event).catch(() => null)

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

  const history = parseWidgetHistory(body?.history)
  if (!history) {
    throw createError({ statusCode: 422, message: 'Malformed conversation history' })
  }

  // Judged before anything is written or sent upstream, so a full conversation
  // costs neither a row to roll back nor a call to pay for.
  const budget = history.reduce((n, h) => n + estimateTokens(h.text), estimateTokens(text))
  if (budget >= CONVERSATION_TOKEN_BUDGET) {
    throw createError({
      statusCode: 409,
      message: 'This conversation is full',
      data: { code: 'conversation_full' },
    })
  }

  const rawId = body?.conversationId
  const requestedId = isConversationId(rawId) ? rawId : null
  // A malformed id names a conversation that cannot exist, not a new one.
  if (rawId && !requestedId) {
    throw createError({ statusCode: 404, message: 'Conversation not found' })
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

  // A conversation belongs to the one visitor who started it, in that one org.
  let needsTitle = true
  if (requestedId) {
    const [owned] = await db
      .select({ title: conversation.title })
      .from(conversation)
      .where(ownedConversation(requestedId, orgId, userId))
      .limit(1)
    if (!owned) {
      throw createError({ statusCode: 404, message: 'Conversation not found' })
    }
    needsTitle = owned.title === null
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
    needsTitle,
  )

  // Stored before the model is asked anything: a failed call then leaves an
  // unanswered message, where writing afterwards would lose what they typed.
  const sentAt = new Date()
  const conversationId = await db.transaction(async (tx) => {
    let id = requestedId
    if (id) {
      await tx.update(conversation)
        .set({ previewText: text, lastMessageAt: sentAt })
        .where(eq(conversation.id, id))
    }
    else {
      const [row] = await tx.insert(conversation)
        .values({ orgId, userId, previewText: text, lastMessageAt: sentAt })
        .returning({ id: conversation.id })
      id = row!.id
    }
    await tx.insert(message).values({ conversationId: id, role: 'user', text, images })
    return id
  })

  // Images are attached to the post but never sent to the model: extraction is
  // text-only for now, so a screenshot-only message is unrecognized by design.
  let parsed: WidgetAiOutput | null = null
  try {
    const client = new OpenAI({ apiKey, baseURL })
    const resp = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        ...historyToMessages(history),
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
    // degrades to the same dead end as an unusable message. Any other 400 is a
    // fault in the request we built, which the visitor cannot act on.
    const status = (err as { status?: number })?.status
    const code = (err as { code?: string })?.code
    if (status === 400 && code === 'content_filter') {
      parsed = { type: 'unrecognized' }
    }
    else {
      const detail = err instanceof Error ? err.message : 'Unknown AI error'
      throw createError({ statusCode: 502, message: `AI extraction failed: ${detail}` })
    }
  }

  // A malformed response is a transient model failure — the SDK may retry.
  if (!parsed) {
    throw createError({ statusCode: 502, message: 'AI returned an unusable response' })
  }
  const ai = parsed

  // Written here rather than by the model, so they have to follow the message
  // themselves. The frame's locale is no help — it renders English either way.
  const zh = HAN.test(text)

  // The model picks a board by NAME — it cannot reliably copy a uuid. Resolve it
  // here and fall back to the first board so a miss never blocks the post.
  const boardRow = ai.type === 'feedback'
    ? (boards.find(b => b.name.toLowerCase() === ai.boardName?.toLowerCase()) ?? boards[0] ?? null)
    : null
  const content = ai.type === 'feedback' ? appendImages(ai.content!, images) : ''

  let reply: string
  if (ai.type === 'support') {
    reply = supportReply(widgetRow?.supportEmail ?? null, zh)
  }
  else if (ai.type === 'unrecognized') {
    reply = unrecognizedReply(orgInfo?.name || (zh ? '这个产品' : 'this product'), zh)
  }
  else if (ai.type === 'clarify') {
    reply = ai.reply!.trim()
  }
  else {
    reply = ai.reply?.trim() || 'Thanks — I turned that into a feedback post for you.'
  }

  const nextTitle = needsTitle && ai.type !== 'clarify'
    ? (truncateTitle(ai.conversationTitle?.trim() || fallbackTitle(history, text)) || null)
    : null

  // The post and the reply that announces it commit together: a post no
  // conversation points at is unreachable from the widget.
  const created = await db.transaction(async (tx) => {
    const post = ai.type === 'feedback'
      ? await createPostRecord({
          orgId,
          authorId: userId,
          title: truncateTitle(ai.title!),
          content,
          boardId: boardRow?.id ?? null,
          subscribeAuthor: !isActorAdmin(session, orgId),
        }, tx)
      : null
    await tx.insert(message).values({
      conversationId,
      role: 'assistant',
      kind: ai.type,
      text: reply,
      postId: post?.id ?? null,
    })
    await tx.update(conversation)
      .set({
        previewText: reply,
        lastMessageAt: new Date(),
        unread: true,
        ...(nextTitle ? { title: nextTitle } : {}),
      })
      .where(eq(conversation.id, conversationId))
    return post
  })

  // Both of these read committed rows, so they follow the transaction.
  if (created) {
    event.waitUntil(
      generatePostEmbedding(created.id, orgId, created.title, content, created.contentHash),
    )
    if (!isActorAdmin(session, orgId)) {
      event.waitUntil(
        emitAdminNotification({
          orgId,
          typeKey: 'post.created',
          postSlug: created.slug,
          postTitle: created.title,
          snippet: content,
          actorId: userId,
          requestOrigin: getRequestURL(event).origin,
        }).catch((err: unknown) => console.error('[notifications] widget post created emit failed', err)),
      )
    }
  }

  return {
    conversationId,
    type: ai.type,
    reply,
    ...(nextTitle ? { conversationTitle: nextTitle } : {}),
    ...(created ? { post: postSummary(created, boardRow?.name ?? null) } : {}),
  }
})

function postSummary(created: CreatedPost, boardName: string | null) {
  return {
    id: created.id,
    slug: created.slug,
    title: created.title,
    board: boardName,
    status: created.status,
  }
}

// Server-composed so the mailto and the wording can't drift with the model. With
// no support email configured the user is still pointed at support, just without
// an address — per the requirement.
// Enough while the product ships only English and Chinese; a third language
// would need a real detector.
const HAN = /[一-鿿]/

// title is varchar(200) and Postgres counts code points, so this does too —
// .slice counts UTF-16 units and would halve an emoji into a lone surrogate.
const TITLE_MAX = 200
function truncateTitle(title: string): string {
  const chars = Array.from(title)
  return chars.length > TITLE_MAX ? chars.slice(0, TITLE_MAX).join('') : title
}

// history is the client's copy: a wrong opening message costs only a label.
const CONVERSATION_TITLE_CHARS = 20
function fallbackTitle(history: WidgetHistoryTurn[], current: string): string {
  const first = history.find(h => h.role === 'user')?.text || current
  const chars = Array.from(first)
  return chars.length > CONVERSATION_TITLE_CHARS ? chars.slice(0, CONVERSATION_TITLE_CHARS).join('') : first
}

// No email configured still guides the visitor to support, just without one to
// point at — the requirement is explicit about that.
function supportReply(supportEmail: string | null, zh: boolean): string {
  if (zh) {
    return supportEmail
      ? `抱歉!这个问题需要人工处理 —— 请邮件联系 [${supportEmail}](mailto:${supportEmail}),团队会直接回复你。`
      : '抱歉!这个问题需要人工处理 —— 请直接联系客服团队,他们会尽快回复你。'
  }
  return supportEmail
    ? `Sorry about that! This needs a real person — email [${supportEmail}](mailto:${supportEmail}) and the team will get back to you directly.`
    : 'Sorry about that! This needs a real person — please reach out to the support team directly and they will get back to you.'
}

function unrecognizedReply(product: string, zh: boolean): string {
  if (zh) {
    return `谢谢你的留言!不过我没能从中找到具体的产品问题或需求。\n\n如果有什么用起来不顺,或者你希望 ${product} 做得更好,直接在这里说就行,我会转达给团队。`
  }
  return `Thanks for the note! I couldn't find a product problem or request in it.\n\nIf something isn't working — or you wish ${product} did something better — just describe it here and it will reach the team.`
}

// Attachment keys use the attachment: protocol so the renderer resolves them
// through /api/files (see app/utils/attachment.ts).
function appendImages(content: string, images: string[]): string {
  if (images.length === 0) return content
  return `${content}\n\n${images.map(k => `![](attachment:${k})`).join('\n')}`
}
