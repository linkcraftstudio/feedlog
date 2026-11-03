import type { H3Event } from 'h3'
import { getRequestURL } from 'h3'
import { and, eq, inArray } from 'drizzle-orm'
import type { PoolClient } from 'pg'
import { uuidv7 } from 'uuidv7'
import { db } from '../../db'
import { board, organization, post, postSubscription, user, vote } from '../../db/schemas'
import { createArticle, createCollection } from '../../services/help-center'
import { updatePortalSettings } from '../../services/portal-settings'
import { runAfterCommit, type ContentContext } from '../../services/content-context'
import { createPostRecord } from '../../utils/post-create'
import { generatePostEmbedding } from '../../utils/embedding'
import { invalidateOrgInfo } from '../../utils/org-cache'
import { appendItem, transaction } from '../agent/runtime'
import { eventItem } from '../inbox/service'
import { withHelpPool } from '../help-search/runtime'
import { helpVectorsEnabled } from '../help-search/embedding'
import { parseOrgMetadata } from '../../../shared/utils/branding'
import { WIDGET_BUILTIN_RULES } from '../../../shared/constants/widget-rules'
import type { Content, FeedbackPart, Part } from '../../../shared/agent/content'
import {
  SAMPLE_ARTICLES, SAMPLE_COLLECTIONS, SAMPLE_CONVERSATIONS, SAMPLE_CUSTOMERS, SAMPLE_FEEDBACK, SAMPLE_PREFIX,
  sampleCustomerEmail, type SampleArticleKey, type SampleConversation, type SampleCustomerKey, type SampleFeedbackKey,
} from './sample-content'

export interface SeedOnboardingInput {
  orgId: string
  // The user the guide opens for: whoever created the workspace, or the first
  // owner of default-org.
  ownerId: string
  // Present inside a request. Without it (the OSS auth hook) after-commit work
  // that needs waitUntil runs inline instead.
  event?: H3Event
}

export interface SeedOnboardingResult {
  content: 'seeded' | 'skipped' | 'failed'
  conversations: 'seeded' | 'skipped' | 'failed'
}

const minutesAgo = (now: number, minutes: number) => new Date(now - minutes * 60_000)

// Writes the new-organization sample data and onboarding flags. Never throws:
// organization creation must succeed even when seeding does not.
//
// Two transactions because the help/feedback services write through Drizzle
// (postgres-js) while conversation items go through the Inbox's pg PoolClient;
// the two drivers cannot share one. The metadata marker commits with the first,
// so a rerun skips it; the second guards itself by "do the sample customers
// already have conversations here" and looks everything up by fixed content.
export async function seedOnboarding(input: SeedOnboardingInput): Promise<SeedOnboardingResult> {
  const now = Date.now()
  const result: SeedOnboardingResult = { content: 'failed', conversations: 'failed' }
  let slug: string | undefined
  try {
    const content = await seedContent(input, now)
    slug = content.slug
    result.content = content.seeded ? 'seeded' : 'skipped'
  } catch (error) {
    console.error('[onboarding] Sample content seed failed', { orgId: input.orgId, error })
    return result
  }
  try {
    result.conversations = await withHelpPool(input.event, pool => transaction({ pool }, client => seedConversations(client, input.orgId, now)))
      ? 'seeded'
      : 'skipped'
  } catch (error) {
    console.error('[onboarding] Sample conversation seed failed', { orgId: input.orgId, error })
  }
  if (result.content === 'seeded') await afterContentCommit(input, slug)
  return result
}

async function seedContent({ orgId, ownerId, event }: SeedOnboardingInput, now: number) {
  const afterCommit: ContentContext['afterCommit'] = []
  const outcome = await db.transaction(async (tx) => {
    // Serializes concurrent seeds of one organization on its row.
    const [org] = await tx.select({ slug: organization.slug, name: organization.name, metadata: organization.metadata })
      .from(organization).where(eq(organization.id, orgId)).for('update')
    if (!org) throw new Error('Organization not found')
    const onboarding = parseOrgMetadata(org.metadata).onboarding as { sampleSeededAt?: string } | undefined
    if (onboarding?.sampleSeededAt) return { slug: org.slug, seeded: false }

    const product = (text: string) => text.replaceAll('{{product}}', org.name)
    await tx.insert(user).values(SAMPLE_CUSTOMERS.map(customer => ({
      id: uuidv7(), name: customer.name, email: sampleCustomerEmail(customer.emailLocal, orgId), emailVerified: false, isAnonymous: false,
    }))).onConflictDoNothing()
    const customers = await customerIds(tx, orgId)

    const context: ContentContext = {
      db: tx, orgId, userId: ownerId, role: 'owner', afterCommit,
      origin: event ? getRequestURL(event).origin : (process.env.BETTER_AUTH_URL || 'http://localhost:3000'),
      // Only read by after-commit tasks, which run solely when an event exists.
      event: event as H3Event,
    }
    const collections = new Map<string, string>()
    for (const collection of SAMPLE_COLLECTIONS) {
      const created = await createCollection(context, { name: collection.name, description: collection.description, icon: collection.icon, visible: true })
      collections.set(collection.key, created.id)
    }
    for (const article of SAMPLE_ARTICLES) {
      await createArticle(context, {
        collectionId: collections.get(article.collection)!, title: article.title, description: article.description,
        content: product(article.content), publish: true, aiEnabled: true,
      })
    }

    const boards = await tx.select({ id: board.id, name: board.name }).from(board).where(eq(board.orgId, orgId))
    for (const feedback of SAMPLE_FEEDBACK) {
      const created = await createPostRecord({
        orgId, authorId: customers.get(feedback.author)!, title: feedback.title, content: feedback.content,
        boardId: boards.find(row => row.name === feedback.board)?.id ?? null, subscribeAuthor: true,
      }, tx)
      const at = minutesAgo(now, feedback.minutesAgo)
      const voters = feedback.voters.map(key => customers.get(key)!)
      if (voters.length) {
        await tx.insert(vote).values(voters.map(userId => ({ postId: created.id, userId, createdAt: at }))).onConflictDoNothing()
        await tx.insert(postSubscription).values(voters.map(userId => ({ postId: created.id, userId }))).onConflictDoNothing()
      }
      await tx.update(post).set({ status: feedback.status, voteCount: voters.length, createdAt: at, updatedAt: at }).where(eq(post.id, created.id))
    }

    // Without a published Help Center the Agent may read articles but not cite them.
    await updatePortalSettings(context, true)
    const [current] = await tx.select({ metadata: organization.metadata }).from(organization).where(eq(organization.id, orgId))
    const metadata = parseOrgMetadata(current!.metadata)
    const guest = metadata.guest && typeof metadata.guest === 'object' ? metadata.guest : {}
    // New workspaces open every guest action so the Agent can post, vote and comment for
    // signed-out customers; owners can turn them off if spam shows up. The global defaults
    // stay closed so existing workspaces are never opened by an upgrade.
    await tx.update(organization).set({ metadata: JSON.stringify({
      ...metadata,
      guest: { ...guest, allowPost: true, allowVote: true, allowComment: true },
      onboarding: { sampleSeededAt: new Date(now).toISOString(), autoOpenFor: ownerId },
    }) }).where(eq(organization.id, orgId))
    return { slug: org.slug, seeded: true }
  })
  // Help index kicks and the org cache invalidation queued by the services.
  if (outcome.seeded && event) runAfterCommit({ event, afterCommit })
  return outcome
}

async function customerIds(database: Pick<typeof db, 'select'>, orgId: string) {
  const emails = SAMPLE_CUSTOMERS.map(customer => sampleCustomerEmail(customer.emailLocal, orgId))
  const rows = await database.select({ id: user.id, email: user.email }).from(user).where(inArray(user.email, emails))
  const ids = new Map<SampleCustomerKey, string>()
  for (const customer of SAMPLE_CUSTOMERS) {
    const row = rows.find(r => r.email === sampleCustomerEmail(customer.emailLocal, orgId))
    if (row) ids.set(customer.key, row.id)
  }
  return ids
}

async function afterContentCommit({ orgId, event }: SeedOnboardingInput, slug: string | undefined) {
  const embeddings = (async () => {
    const titles = SAMPLE_FEEDBACK.map(feedback => feedback.title)
    const rows = await db.select({ id: post.id, title: post.title, content: post.content, contentHash: post.contentHash })
      .from(post).where(and(eq(post.orgId, orgId), inArray(post.title, titles)))
    // Directly, not through feedback.created: that event notifies admins and counts as real feedback.
    for (const row of rows) await generatePostEmbedding(row.id, orgId, row.title, row.content, row.contentHash ?? '')
  })().catch(error => console.error('[onboarding] Sample feedback embedding failed', { orgId, error }))
  if (event) {
    event.waitUntil(embeddings)
    return
  }
  await embeddings
  try {
    if (slug) await invalidateOrgInfo(slug)
    if (helpVectorsEnabled()) {
      const { requestSchedule } = await import('../inbox/platform')
      await requestSchedule()
    }
  } catch (error) {
    console.error('[onboarding] Post-seed wake-up failed', { orgId, error })
  }
}

interface SampleRefs {
  customers: Map<SampleCustomerKey, string>
  articles: Map<SampleArticleKey, { article_id: string; slug: string; title: string }>
  feedback: Map<SampleFeedbackKey, { id: string; slug: string; title: string; board_id: string | null; board_name: string; status: string; vote_count: number }>
}

async function loadRefs(client: PoolClient, orgId: string): Promise<SampleRefs> {
  const customers = new Map<SampleCustomerKey, string>()
  const { rows: users } = await client.query<{ id: string; email: string }>('SELECT id,email FROM "user" WHERE email=ANY($1)',
    [SAMPLE_CUSTOMERS.map(customer => sampleCustomerEmail(customer.emailLocal, orgId))])
  for (const customer of SAMPLE_CUSTOMERS) {
    const row = users.find(r => r.email === sampleCustomerEmail(customer.emailLocal, orgId))
    if (row) customers.set(customer.key, row.id)
  }
  const articles: SampleRefs['articles'] = new Map()
  const { rows: articleRows } = await client.query<{ id: string; short_id: string; slug: string; title: string }>(
    "SELECT id,short_id,slug,title FROM help_article WHERE org_id=$1 AND status='published' AND title=ANY($2)",
    [orgId, SAMPLE_ARTICLES.map(article => article.title)])
  for (const article of SAMPLE_ARTICLES) {
    const row = articleRows.find(r => r.title === article.title)
    if (row) articles.set(article.key, { article_id: row.id, slug: `${row.short_id}-${row.slug}`, title: row.title })
  }
  const feedback: SampleRefs['feedback'] = new Map()
  for (const item of SAMPLE_FEEDBACK) {
    const author = customers.get(item.author)
    if (!author) continue
    const { rows: [row] } = await client.query(`SELECT p.id,p.slug,p.title,p.board_id,p.status,p.vote_count,b.name AS board_name
      FROM post p LEFT JOIN board b ON b.id=p.board_id WHERE p.org_id=$1 AND p.author_id=$2 AND p.title=$3 ORDER BY p.created_at LIMIT 1`, [orgId, author, item.title])
    if (row) feedback.set(item.key, { ...row, board_name: row.board_name ?? 'Feedback', vote_count: Number(row.vote_count) })
  }
  return { customers, articles, feedback }
}

// Returns false when the conversations already exist or their customers are missing.
async function seedConversations(client: PoolClient, orgId: string, now: number) {
  await client.query('SELECT id FROM organization WHERE id=$1 FOR UPDATE', [orgId])
  const refs = await loadRefs(client, orgId)
  if (refs.customers.size !== SAMPLE_CUSTOMERS.length) return false
  const { rowCount } = await client.query('SELECT 1 FROM conversation WHERE org_id=$1 AND user_id=ANY($2) LIMIT 1', [orgId, [...refs.customers.values()]])
  if (rowCount) return false
  for (const conversation of SAMPLE_CONVERSATIONS) await seedConversation(client, orgId, now, conversation, refs)
  return true
}

async function seedConversation(client: PoolClient, orgId: string, now: number, sample: SampleConversation, refs: SampleRefs) {
  const id = uuidv7()
  const customerId = refs.customers.get(sample.customer)!
  const createdAt = minutesAgo(now, sample.steps[0]!.minutesAgo)
  await client.query('INSERT INTO conversation (id,org_id,user_id,created_at) VALUES ($1,$2,$3,$4)', [id, orgId, customerId, createdAt])
  // appendItem stamps clock_timestamp(); each item is backdated right after it
  // is appended, keeping seq order and time order the same.
  const backdate = (itemId: string, at: Date) => client.query('UPDATE conversation_item SET created_at=$2 WHERE id=$1', [itemId, at])
  let trigger: string | null = null
  let lastVisible = createdAt
  for (const step of sample.steps) {
    const at = minutesAgo(now, step.minutesAgo)
    if (step.kind === 'customer') {
      const item = await appendItem(client, { id: uuidv7(), conversationId: id, author: 'customer', userId: customerId, content: { parts: [{ type: 'text', text: step.text }] } })
      await backdate(item.id, at)
      trigger = item.id
      lastVisible = at
    } else if (step.kind === 'agent') {
      const started = new Date(at.getTime() - 4000)
      const runId = await insertRun(client, id, trigger!, 'completed', started, at)
      const item = await appendItem(client, { id: uuidv7(), conversationId: id, author: 'agent', runId, content: agentContent(step, refs) })
      await backdate(item.id, at)
      lastVisible = at
    } else if (step.kind === 'handoff') {
      const runId = await insertRun(client, id, trigger!, 'cancelled', new Date(at.getTime() - 3000), at)
      const rule = step.ruleId ? WIDGET_BUILTIN_RULES.find(r => r.id === step.ruleId) : undefined
      const item = await eventItem(client, id, {
        kind: 'handoff', reason: step.reason, fromStatus: 'ai_handling', toStatus: 'open',
        ...(rule ? { rule: { id: rule.id, scenario: rule.scenario, scenarioZh: rule.scenarioZh } } : {}),
      }, { id: `handoff:${runId}` })
      await backdate(item.id, at)
    } else {
      const item = await eventItem(client, id, { kind: 'closed', reason: 'timeout', fromStatus: 'ai_handling', toStatus: 'closed' })
      await backdate(item.id, at)
    }
  }
  // Same priority rule as handoffLocked: rule and knowledge-gap handoffs stay normal.
  const handoff = sample.steps.find(step => step.kind === 'handoff')
  const priority = handoff?.kind === 'handoff' && !['knowledge_gap', 'support_rule'].includes(handoff.reason) ? 1 : 0
  // Title and preview are derived from the messages; prefixing them marks the
  // conversation as sample in the Inbox list and header without touching what
  // the customer "said". A later message replaces the preview, not the title.
  await client.query(`UPDATE conversation SET status=$2,priority=$3,state_due_at=NULL,last_message_at=$4,
    title=$5 || title, preview_text=$5 || preview_text WHERE id=$1`, [id, sample.status, priority, lastVisible, SAMPLE_PREFIX])
  const feedbackStep = sample.steps.find(step => step.kind === 'agent' && step.feedback?.type === 'feedback_created')
  if (feedbackStep?.kind === 'agent') {
    const created = refs.feedback.get(feedbackStep.feedback!.key)
    if (created) await client.query('UPDATE post SET source_conversation_id=$2 WHERE id=$1 AND org_id=$3', [created.id, id, orgId])
  }
}

async function insertRun(client: PoolClient, conversationId: string, triggerItemId: string, status: 'completed' | 'cancelled', startedAt: Date, finishedAt: Date) {
  const id = uuidv7()
  await client.query(`INSERT INTO agent_run (id,conversation_id,trigger_item_id,idempotency_key,status,started_at,deadline_at,finished_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, conversationId, triggerItemId, `sample:${id}`, status, startedAt, new Date(startedAt.getTime() + 120_000), finishedAt])
  return id
}

function agentContent(step: Extract<SampleConversation['steps'][number], { kind: 'agent' }>, refs: SampleRefs): Content {
  const parts: Part[] = [{ type: 'text', text: step.text }]
  // A missing reference (deleted before a rerun) just drops its card.
  const articles = (step.articles ?? []).map(key => refs.articles.get(key)).filter(article => !!article)
  if (articles.length) parts.push({ type: 'article_reference', articles })
  const feedback = step.feedback && refs.feedback.get(step.feedback.key)
  if (step.feedback && feedback) {
    const card: FeedbackPart = {
      type: step.feedback.type, feedback_id: feedback.id, slug: feedback.slug, title: feedback.title,
      board_id: feedback.board_id, board_name: feedback.board_name, status_id: feedback.status,
      vote_count: feedback.vote_count, has_voted: step.feedback.type === 'feedback_upvoted',
    }
    parts.push(card)
  }
  return { parts }
}

// Clears the guide's auto-open marker once its user has closed the guide.
// Returns whether the marker was cleared. Other users never touch it.
export async function clearOnboardingAutoOpen(orgId: string, userId: string): Promise<boolean> {
  const slug = await db.transaction(async (tx) => {
    const [org] = await tx.select({ slug: organization.slug, metadata: organization.metadata })
      .from(organization).where(eq(organization.id, orgId)).for('update')
    if (!org) return null
    const metadata = parseOrgMetadata(org.metadata)
    const onboarding = metadata.onboarding && typeof metadata.onboarding === 'object' ? { ...metadata.onboarding as Record<string, unknown> } : null
    if (!onboarding || onboarding.autoOpenFor !== userId) return null
    delete onboarding.autoOpenFor
    await tx.update(organization).set({ metadata: JSON.stringify({ ...metadata, onboarding }) }).where(eq(organization.id, orgId))
    return org.slug
  })
  if (slug === null) return false
  await invalidateOrgInfo(slug).catch(error => console.error('[onboarding] Org cache invalidation failed', { orgId, error }))
  return true
}
