import { AgentDependencyTimeout, withDependencyTimeout } from './dependency-timeout'
import { HelpEmbeddingError } from '../help-search/embedding'
import { handoff } from '../inbox/service'
import { handoffReason } from '../../../shared/inbox/state'
import { handoffCustomerNoticeInput } from './handoff-notice'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { uuidv7 } from 'uuidv7'
import { createHash } from 'node:crypto'
import slugify from 'slugify'
import { getRequestURL, type H3Event } from 'h3'
import type { PoolClient } from 'pg'
import { stripMarkdown, generateExcerpt } from '../../../shared/utils/markdown'
import { isActorAdmin, type OrgListSession } from '../../../shared/utils/notifications'
import type { Part, FeedbackPart, StreamEvent } from '../../../shared/agent/content'
import { agentRuntime, transaction, lockConversation, type Actor } from './runtime'
import type { AgentPromptContext } from './prompts/system'
import { helpArticleSearchInput, helpArticleSearchDescription, searchHelpArticles } from './help-search'
import { resolvePortalModules } from '../../../shared/utils/portal-modules'

interface FeedbackRow {
  id: string; author_id: string; title: string; content: string; slug: string
  status: string; board_id: string; board_name: string | null; vote_count: number
  has_voted: boolean; subscribed: boolean; edit_window_open: boolean; community_activity: boolean
}
type Effect = { id: string; kind: string; triggerId: string; feedbackId?: string }
export function feedlogTools(event: H3Event, actor: Actor, conversationId: string, runId: string, triggerId: string, signal: AbortSignal, emit: (event: StreamEvent) => void, promptContext: AgentPromptContext, onHandoff?: (unavailable?: boolean) => void, onFailure?: () => void) {
  const runtime = agentRuntime(event)
  const { pool, memory } = runtime
  const cards: Part[] = []
  const articles = new Map<string, { article_id: string; slug: string; title: string; customer_visible: boolean }>()
  const hash = (title: string, content: string) => createHash('sha256').update(`${title}\n${content}`).digest('hex')
  const addCard = (card: FeedbackPart) => {
    const i = cards.findIndex(p => p.type === card.type && 'feedback_id' in p && p.feedback_id === card.feedback_id)
    if (i >= 0) cards[i] = card; else cards.push(card)
    return card
  }
  async function active(client: PoolClient) {
    signal.throwIfAborted()
    await lockConversation(client, conversationId, actor)
    // now() is frozen at BEGIN, so a slow tool must check the advancing clock.
    const { rowCount } = await client.query("SELECT id FROM agent_run WHERE id=$1 AND conversation_id=$2 AND status='running' AND deadline_at > clock_timestamp()", [runId, conversationId])
    if (!rowCount) throw new Error('Run is no longer active')
  }
  async function effects() {
    const thread = await memory.getThreadById({ threadId: conversationId })
    return { thread, entries: (thread?.metadata?.effects ?? {}) as Record<string, Effect> }
  }
  async function reserve(kind: string, feedbackId?: string) {
    const { thread, entries } = await effects()
    const key = `${triggerId}:${kind}:${feedbackId ?? ''}`
    if (entries[key]) return entries[key]!
    const entry = { id: uuidv7(), kind, triggerId, feedbackId }
    // Reserve before the business write, so a crash after commit still leaves provenance.
    await memory.updateThread({ id: conversationId, metadata: { ...thread?.metadata, effects: { ...entries, [key]: entry } } })
    return entry
  }
  async function createdIds(kind: string) {
    const { entries } = await effects()
    return new Set(Object.values(entries).filter(entry => entry.kind === kind).map(entry => entry.id))
  }
  async function owned(id: string, kind: string) {
    if (!(await createdIds(kind)).has(id)) throw new Error('Only content created by this Agent in this conversation can be edited')
  }
  function feedbackEditable(p: FeedbackRow, ids: Set<string>) {
    return p.author_id === actor.customerId && ids.has(p.id) && p.edit_window_open && !p.community_activity
  }
  function feedbackDetails(p: FeedbackRow, ids: Set<string>) {
    return { feedback_id: p.id, title: p.title, content: p.content, slug: p.slug, url: new URL(`/p/${p.slug}`, getRequestURL(event).origin).href,
      status: p.status, board_name: p.board_name, vote_count: p.vote_count, has_voted: p.has_voted, subscribed: p.subscribed,
      editable: feedbackEditable(p, ids) }
  }
  async function postRow(client: Pick<PoolClient, 'query'>, id: string, forUpdate = false) {
    const { rows: [p] } = await client.query(`SELECT p.*,b.name AS board_name, EXISTS(SELECT 1 FROM vote v WHERE v.post_id=p.id AND v.user_id=$3) AS has_voted,
      EXISTS(SELECT 1 FROM post_subscription s WHERE s.post_id=p.id AND s.user_id=$3) AS subscribed,
      p.created_at>now()-interval '10 minutes' AS edit_window_open,
      (EXISTS(SELECT 1 FROM vote v WHERE v.post_id=p.id AND v.user_id<>$3) OR EXISTS(SELECT 1 FROM comment c WHERE c.post_id=p.id AND c.author_id<>$3)) AS community_activity
      FROM post p LEFT JOIN board b ON b.id=p.board_id AND b.org_id=p.org_id WHERE p.id=$1 AND p.org_id=$2 AND p.merged_to IS NULL${forUpdate ? ' FOR UPDATE OF p' : ''}`, [id, actor.orgId, actor.customerId])
    if (!p) throw new Error('Feedback not found or already merged')
    return p
  }
  function card(p: FeedbackRow, type: FeedbackPart['type'], comment?: { id: string; content: string }): FeedbackPart {
    return { type, feedback_id: p.id, slug: p.slug, title: p.title, board_id: p.board_id, board_name: p.board_name ?? 'Feedback',
      status_id: p.status, vote_count: p.vote_count, has_voted: p.has_voted,
      ...(comment ? { comment_id: comment.id, comment_text: comment.content } : {}) } as FeedbackPart
  }
  function tool<T extends z.ZodType>(name: string, description: string, inputSchema: T, execute: (input: z.infer<T>) => Promise<unknown>) {
    return createTool({ id: name, description, inputSchema, execute: async (input, context) => {
      signal.throwIfAborted()
      const callId = context?.agent?.toolCallId ?? uuidv7()
      const startedAt = Date.now()
      emit({ type: 'tool', runId, callId, name, phase: 'start', data: input })
      try {
        const result = await (['search_help_articles', 'read_help_article', 'search_feedback'].includes(name)
          ? withDependencyTimeout(() => execute(input as z.infer<T>), signal)
          : execute(input as z.infer<T>))
        emit({ type: 'tool', runId, callId, name, phase: 'finish', data: result, durationMs: Date.now() - startedAt })
        return result
      } catch (error) {
        if (error instanceof AgentDependencyTimeout || error instanceof HelpEmbeddingError) { onFailure?.(); throw error }
        if (signal.aborted) throw error
        const result = { error: error instanceof Error ? error.message : 'Tool failed' }
        emit({ type: 'tool', runId, callId, name, phase: 'finish', data: result, durationMs: Date.now() - startedAt })
        return result
      }
    } })
  }
  async function write<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return transaction(runtime, async client => {
      await active(client)
      const result = await fn(client)
      await active(client)
      return result
    })
  }
  async function attachImages(content: string, images?: string[]) {
    if (!images?.length) return content
    const { rows } = await pool.query(`SELECT part->>'storage_key' AS key FROM conversation_item,
      LATERAL jsonb_array_elements(content->'parts') part
      WHERE conversation_id=$1 AND author_type='customer' AND part->>'type'='image'`, [conversationId])
    const allowed = new Set(rows.map(row => row.key))
    if (images.some(key => !allowed.has(key))) throw new Error('Use images supplied by the customer in this conversation')
    return `${content}\n\n${[...new Set(images)].map(key => `![](attachment:${key})`).join('\n')}`
  }
  const imageInput = z.array(z.string().min(1).max(1000)).max(10).optional().describe('Storage keys of images supplied by this customer in this conversation, relevant to the feedback.')
  async function transfer({ reason, rule_id, customer_notice }: { reason: import('../../../shared/inbox/state').HandoffReason; rule_id?: string; customer_notice: string }) {
    const rule = reason === 'support_rule' ? promptContext.supportRules.find(rule => rule.id === rule_id) : undefined
    if (reason === 'support_rule' && !rule) return { error: 'Choose a matching configured support rule ID, or use the appropriate other handoff reason.' }
    if (reason !== 'support_rule' && rule_id) return { error: 'rule_id is only valid for support_rule.' }
    try {
      const saved = await handoff(runtime, conversationId, actor.orgId, runId, reason, true, rule, await feedbackResults(), getRequestURL(event).origin, customer_notice)
      if (!saved) throw new Error('Handoff was not completed')
    } catch (error) {
      onHandoff?.(true)
      throw error
    }
    onHandoff?.()
    return { handoff: true, status: 'open', stop: true }
  }
  const idInput = z.object({ feedback_id: z.uuid() })
  const tools = {
    handoff_to_human: createTool({
      id: 'handoff_to_human', description: 'Transfer this conversation to human support and end AI handling only after an explicit request for a person, acceptance of an offer to involve one, or a matching mandatory support rule. A knowledge miss, frustration, a how-to question, or a failed tool alone is not consent. Feature suggestions, bug reports and requests to leave feedback use feedback tools; do not replace them with handoff. For a mixed request, finish the appropriate feedback action before calling this tool. Never call it in parallel with another tool.',
      inputSchema: z.object({ reason: handoffReason, rule_id: z.string().min(1).optional().describe('Required for support_rule: the matching enabled rule ID from the configured support rules. Omit for other reasons.'), customer_notice: handoffCustomerNoticeInput }).strict(),
      execute: transfer,
    }),
    search_help_articles: tool('search_help_articles', helpArticleSearchDescription, helpArticleSearchInput, input => searchHelpArticles(pool, actor.orgId, input, getRequestURL(event).origin)),
    read_help_article: tool('read_help_article', 'Read an AI-enabled article by article_id or the shortId-slug segment of an internal article link. Follow relevant links to establish facts. customer_visible determines whether it can be cited publicly; internal articles can inform answers.', z.object({ article_id: z.uuid().optional(), slug: z.string().min(1).max(200).optional() }).refine(input => !!input.article_id !== !!input.slug, 'Provide either article_id or slug'), async ({ article_id, slug }) => {
      const { rows: [article] } = await pool.query(`SELECT a.id AS article_id,a.short_id,a.slug,a.title,a.content,(a.status='published' AND c.visible) AS published,o.metadata FROM help_article a JOIN help_collection c ON c.id=a.collection_id JOIN organization o ON o.id=a.org_id
        WHERE (a.id::text=$1 OR a.short_id||'-'||a.slug=$2) AND a.org_id=$3 AND c.org_id=a.org_id AND a.ai_enabled`, [article_id ?? null, slug ?? null, actor.orgId])
      if (!article) throw new Error('Article not accessible')
      const route = `${article.short_id}-${article.slug}`
      const customer_visible = article.published && resolvePortalModules(article.metadata).helpCenter
      const reference = { article_id: article.article_id, slug: route, title: article.title, customer_visible }
      articles.set(article.article_id, reference)
      return { ...reference, content: article.content, url: customer_visible ? new URL(`/help/${route}`, getRequestURL(event).origin).href : null }
    }),
    cite_help_articles: tool('cite_help_articles', 'Attach only articles that directly support the central answer to the customer’s question. Do not include articles read only for background, a generic dashboard link, or an optional navigation detail. Only IDs already read are accepted. The application verifies citation support and renders accepted references as article cards; write the answer in natural language.', z.object({ article_ids: z.array(z.uuid()).min(1).max(8) }), async ({ article_ids }) => {
      const references = [...new Set<string>(article_ids)].map(id => {
        const article = articles.get(id)
        if (!article?.customer_visible) throw new Error('Only a read, customer-visible article can be cited')
        return { article_id: article.article_id, slug: article.slug, title: article.title }
      })
      const index = cards.findIndex(p => p.type === 'article_reference')
      const part = { type: 'article_reference' as const, articles: references }
      if (index >= 0) cards[index] = part; else cards.push(part)
      return { referenced: references.length }
    }),
    list_feedback_boards: tool('list_feedback_boards', 'List valid feedback boards. Select a relevant board before creating feedback.', z.object({}), async () => (await pool.query('SELECT id,name,description FROM board WHERE org_id=$1 ORDER BY position,id', [actor.orgId])).rows),
    search_feedback: tool('search_feedback', 'Find similar public feedback using the same semantic search as the feedback portal, with text similarity as a fallback. Results are ranked candidates; compare their details with the customer\'s actual need before treating them as duplicates or voting. editable indicates whether this Agent can edit the feedback for the current customer in this conversation, not the customer\'s general editing permissions.', z.object({ query: z.string().trim().min(1).max(300).describe('A concise description of the customer\'s problem or requested improvement, including conditions that distinguish it. Use natural language in the customer\'s language or another appropriate language.') }), async ({ query }) => {
      const matches = await searchSimilarByText(query, { orgId: actor.orgId, userId: actor.customerId, limit: 8, embeddingTimeoutMs: 5000 })
      if (!matches.length) return []
      const ids = await createdIds('feedback')
      return Promise.all(matches.map(async match => {
        const p = await postRow(pool, match.id)
        const { content, ...details } = feedbackDetails(p, ids)
        return { ...details, summary: generateExcerpt(content) }
      }))
    }),
    get_feedback: tool('get_feedback', 'Read full feedback, vote/subscription status and visible comments. editable requires ownership, creation in this conversation within ten minutes, and no other users\' votes or comments. Use comments for additions when editing is unavailable. Pass next_comments_cursor to read more comments.', idInput.extend({ comments_cursor: z.uuid().optional() }).strict(), async ({ feedback_id, comments_cursor }) => {
      const p = await postRow(pool, feedback_id)
      const { rows } = await pool.query("SELECT id,author_id,content,created_at,edited_at FROM comment WHERE post_id=$1 AND type='comment' AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 21", [feedback_id, comments_cursor ?? null])
      const ids = await createdIds('comment')
      return { feedback: feedbackDetails(p, await createdIds('feedback')), comments: rows.slice(0, 20).map(c => ({ comment_id: c.id, content: c.content, created_at: c.created_at, edited_at: c.edited_at, editable: c.author_id === actor.customerId && ids.has(c.id) })), next_comments_cursor: rows.length > 20 ? rows[19].id : null }
    }),
    create_feedback: tool('create_feedback', 'Record one public product problem, bug report, or improvement request per customer message. This does not transfer the conversation to a person. Use product guidance for how-to questions; missing knowledge alone is not feedback. Search duplicates first, remove private account details, and preserve the customer\'s actual concern. If the customer also explicitly wants a person, complete this action before handoff. If this message already created feedback, return that feedback; use update_feedback for corrections.', z.object({ title: z.string().min(1).max(200), content: z.string().min(1).max(10000), board_id: z.uuid(), images: imageInput }), async input => {
      input.content = await attachImages(input.content, input.images)
      await assertGuestMay(event, actor.session, 'allowPost')
      const { saved, created } = await write(async client => {
        await active(client)
        const { rowCount } = await client.query('SELECT id FROM board WHERE id=$1 AND org_id=$2', [input.board_id, actor.orgId])
        if (!rowCount) throw new Error('Board is not available')
        const effect = await reserve('feedback')
        const slug = `${slugify(input.title, { lower: true, strict: true }).slice(0, 80)}-${effect.id.slice(-8)}`
        const { rowCount: created } = await client.query(`INSERT INTO post (id,org_id,author_id,board_id,title,content,excerpt,slug,content_hash,source_conversation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`, [effect.id, actor.orgId, actor.customerId, input.board_id, input.title, input.content, generateExcerpt(input.content), slug, hash(input.title, input.content), conversationId])
        if (created) {
          await client.query('INSERT INTO post_search (post_id,org_id,search_text) VALUES ($1,$2,$3)', [effect.id, actor.orgId, stripMarkdown(`${input.title}\n${input.content}`)])
          if (!isActorAdmin(actor.session as OrgListSession, actor.orgId)) await client.query('INSERT INTO post_subscription (post_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [effect.id, actor.customerId])
        }
        return { saved: await postRow(client, effect.id), created: !!created }
      })
      // Commit first so both search paths can read the feedback before the tool completes.
      await generatePostEmbedding(saved.id, actor.orgId, saved.title, saved.content, saved.content_hash)
      if (created) publishDomainEvent(event, createDomainEvent({ name: 'feedback.created', orgId: actor.orgId, userId: actor.customerId, data: { feedbackId: saved.id, boardId: saved.board_id, source: 'widget', messageId: triggerId } }))
      return { ...addCard(card(saved, 'feedback_created')), feedback: feedbackDetails(saved, await createdIds('feedback')) }
    }),
    update_feedback: tool('update_feedback', 'Correct feedback created by this Agent in this conversation, on behalf of the same customer. Read the current record with get_feedback when preparing a correction. Supply only the fields that need changing; omitted fields keep their current saved values. If supplied, content is the complete revised Markdown body, preserving valid details outside the requested correction. Returns the saved feedback and changed flag. When changed is false, the record already matches and no update card is added.', z.object({
      feedback_id: z.uuid(),
      title: z.string().trim().min(1).max(200).optional().describe('The complete corrected title. Omit to keep the saved title.'),
      content: z.string().min(1).max(10000).refine(value => value.trim().length > 0, 'Content must not be blank').optional().describe('The complete revised Markdown body, not a fragment or an instruction. Preserve valid details and omit this field when only changing the title.'),
    }).strict().refine(input => input.title !== undefined || input.content !== undefined, 'Provide title or content'), async input => {
      const { saved, changed } = await write(async client => {
        await active(client); await owned(input.feedback_id, 'feedback')
        const p = await postRow(client, input.feedback_id, true)
        if (!feedbackEditable(p, await createdIds('feedback'))) throw new Error('Feedback is no longer editable; add a comment with the correction instead')
        const title = input.title ?? p.title
        const content = input.content ?? p.content
        const changed = title !== p.title || content !== p.content
        if (changed) {
          await client.query('UPDATE post SET title=$2,content=$3,excerpt=$4,content_hash=$5,updated_at=now() WHERE id=$1', [p.id, title, content, generateExcerpt(content), hash(title, content)])
          await client.query('UPDATE post_search SET search_text=$2 WHERE post_id=$1', [p.id, stripMarkdown(`${title}\n${content}`)])
        }
        const saved = await postRow(client, p.id)
        return { saved, changed }
      })
      if (changed) {
        await generatePostEmbedding(saved.id, actor.orgId, saved.title, saved.content, saved.content_hash)
        addCard(card(saved, 'feedback_updated'))
      }
      return { changed, feedback: feedbackDetails(saved, await createdIds('feedback')) }
    }),
    upvote_and_subscribe_feedback: tool('upvote_and_subscribe_feedback', 'Ensure a vote and subscription only when the customer explicitly expresses the same need or requests voting. Admin accounts can vote but cannot subscribe.', idInput, async ({ feedback_id }) => {
      await assertGuestMay(event, actor.session, 'allowVote')
      return write(async client => {
        await active(client); await postRow(client, feedback_id)
        const { rowCount } = await client.query('INSERT INTO vote (post_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [feedback_id, actor.customerId])
        if (rowCount) await client.query('UPDATE post SET vote_count=vote_count+1 WHERE id=$1', [feedback_id])
        const subscribed = !isActorAdmin(actor.session as OrgListSession, actor.orgId)
        if (subscribed) await client.query('INSERT INTO post_subscription (post_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [feedback_id, actor.customerId])
        const notification_available = subscribed && !isGuestSession(actor.session) && !!actor.session.user.email && resolveEmailProvider().name !== 'console'
        return { ...addCard(card(await postRow(client, feedback_id), 'feedback_upvoted')), subscribed, notification_available }
      })
    }),
    add_feedback_comment: tool('add_feedback_comment', 'Add the customer\'s new details to existing feedback. One comment per target feedback per customer message; retries return the already-created comment.', z.object({ feedback_id: z.uuid(), content: z.string().min(1).max(5000), images: imageInput }), async input => {
      input.content = await attachImages(input.content, input.images)
      const { p, comment, created, part } = await write(async client => {
        await active(client)
        const p = await postRow(client, input.feedback_id)
        if (p.author_id !== actor.customerId) await assertGuestMay(event, actor.session, 'allowComment')
        const effect = await reserve('comment', p.id)
        const { rowCount } = await client.query('INSERT INTO comment (id,post_id,author_id,content) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING', [effect.id, p.id, actor.customerId, input.content])
        if (rowCount) await client.query('UPDATE post SET comment_count=comment_count+1 WHERE id=$1', [p.id])
        const { rows: [comment] } = await client.query('SELECT id,content FROM comment WHERE id=$1', [effect.id])
        return { p, comment, created: !!rowCount, part: card(await postRow(client, p.id), 'feedback_comment_added', comment) }
      })
      if (created) {
        const authorIsAdmin = isActorAdmin(actor.session as OrgListSession, actor.orgId)
        event.waitUntil(emitCommentNotifications({ orgId: actor.orgId, postId: p.id, snippet: comment.content, actorId: actor.customerId, authorIsAdmin, isTopLevel: true, notifyVoters: true, requestOrigin: getRequestURL(event).origin }).catch(error => console.error('[agent] Comment notification failed', error)))
        if (!authorIsAdmin) event.waitUntil(emitAdminNotification({ orgId: actor.orgId, typeKey: 'post.user_commented', postSlug: p.slug, postTitle: p.title, snippet: comment.content, actorId: actor.customerId, requestOrigin: getRequestURL(event).origin }).catch(error => console.error('[agent] Admin notification failed', error)))
      }
      return addCard(part)
    }),
    update_feedback_comment: tool('update_feedback_comment', 'Correct a comment created by this Agent in this conversation, on behalf of the same customer. Returns changed and the saved comment; unchanged content produces no update card.', z.object({ comment_id: z.uuid(), content: z.string().min(1).max(5000) }), async input => write(async client => {
      await active(client); await owned(input.comment_id, 'comment')
      const { rows: [comment] } = await client.query('SELECT * FROM comment WHERE id=$1 AND author_id=$2', [input.comment_id, actor.customerId])
      if (!comment) throw new Error('Comment is not editable')
      await postRow(client, comment.post_id)
      const changed = comment.content !== input.content
      if (changed) await client.query('UPDATE comment SET content=$2,edited_at=now(),updated_at=now() WHERE id=$1', [comment.id, input.content])
      return { changed, comment: { comment_id: comment.id, feedback_id: comment.post_id, content: input.content },
        ...(changed ? addCard(card(await postRow(client, comment.post_id), 'feedback_comment_updated', { id: comment.id, content: input.content })) : {}) }
    })),
  }
  const enabledTools = Object.fromEntries(Object.entries(tools).filter(([name]) => {
    if (name.endsWith('help_articles') || name === 'read_help_article') return promptContext.knowledgeEnabled
    if (name === 'create_feedback' || name === 'list_feedback_boards') return promptContext.feedback.create && promptContext.boards.length > 0
    if (name === 'upvote_and_subscribe_feedback') return promptContext.feedback.vote
    return true
  }))
  async function resultParts() {
    const { rows: [org] } = await pool.query('SELECT metadata FROM organization WHERE id=$1', [actor.orgId])
    const { rows: visible } = await pool.query(`SELECT a.id FROM help_article a JOIN help_collection c ON c.id=a.collection_id AND c.org_id=a.org_id
      WHERE a.org_id=$1 AND a.ai_enabled AND a.status='published' AND c.visible`, [actor.orgId])
    const ids = new Set(resolvePortalModules(org?.metadata).helpCenter ? visible.map(a => a.id) : [])
    // Later tools may change votes or comments already represented by a card.
    const posts = new Map(await Promise.all([...new Set(cards.flatMap(part => 'feedback_id' in part ? [part.feedback_id] : []))].map(async id => [id, await postRow(pool, id)] as const)))
    const refreshed = await Promise.all(cards.map(async part => {
      if (!('feedback_id' in part)) return part
      let comment
      if ('comment_id' in part) {
        const { rows } = await pool.query("SELECT id,content FROM comment WHERE id=$1 AND post_id=$2 AND type='comment'", [part.comment_id, part.feedback_id])
        comment = rows[0]
        if (!comment) throw new Error('Comment is no longer available')
      }
      return card(posts.get(part.feedback_id), part.type, comment)
    }))
    return refreshed.flatMap<Part>(part => part.type === 'article_reference'
      ? (part.articles.some(a => ids.has(a.article_id)) ? [{ ...part, articles: part.articles.filter(a => ids.has(a.article_id)) }] : [])
      : part.type === 'feedback_upvoted' && cards.some(other => other.type === 'feedback_comment_added' && other.feedback_id === part.feedback_id) ? [] : [part])
  }
  async function feedbackResults() {
    let parts = cards
    try { parts = await resultParts() }
    catch { console.warn('[agent] Preserving confirmed feedback receipts without refresh', { conversationId, runId }) }
    return parts.filter((part): part is FeedbackPart => 'feedback_id' in part)
  }
  return { tools: enabledTools, resultParts, feedbackResults, transfer }
}
