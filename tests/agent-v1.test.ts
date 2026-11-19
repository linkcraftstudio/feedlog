import { prepareAgent } from '../server/lib/agent/agent'
import { removeWebSource } from '../server/services/web-source'
import { updateAiTrainingReference } from './fixtures/ai-training-reference'
import { recoverLocked, staffCommand } from '../server/lib/inbox/service'
import { readConversationContext } from '../server/lib/agent/conversation-context'
import { syncRunTask } from '../server/lib/inbox/tasks'
import { inboxTick } from '../server/lib/inbox/tick'
/* eslint-disable @typescript-eslint/no-explicit-any -- Fixtures exercise partial request contexts and heterogeneous tool outputs. */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { uuidv7 } from 'uuidv7'
import { createError } from 'h3'
import { HANDOFF_NOTICE } from '../shared/inbox/state'
import { chatInput, customerContent, pageContext } from '../shared/agent/content'
import { readAgentEvents } from '../shared/agent/sse'
import { agentRuntime, transaction, appendItem, lockConversation, publicItem, type Actor } from '../server/lib/agent/runtime'
import { startRun, failRun, completeRun } from '../server/lib/agent/conversations'
import { feedlogTools } from '../server/lib/agent/tools'
import { searchHelpArticles } from '../server/lib/agent/help-search'
import { loadAgentPromptContext } from '../server/lib/agent/prompts/context'
import { renderAgentSystemPrompt } from '../server/lib/agent/prompts/system'
import { isGuestSession } from '../server/utils/guest'
import { stripMarkdown } from '../shared/utils/markdown'

const event = { waitUntil: (task: Promise<unknown>) => task, path: '/', context: {}, node: { req: { headers: { host: 'example.localhost:3000' }, url: '/' } } } as any
const runtime = agentRuntime(event)
const { pool, memory } = runtime
const url = new URL(process.env.DATABASE_URL!)
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname), 'Integration tests require a local database')
after(() => runtime.close())
Object.assign(globalThis, { createError, stripMarkdown, isGuestSession, assertGuestMay: async () => {}, generatePostEmbedding: async () => {}, resolveEmailProvider: () => ({ name: 'console' }), createDomainEvent: (input: unknown) => input, publishDomainEvent: () => {}, emitCommentNotifications: async () => {}, emitAdminNotification: async () => {} })

const send = (text = 'Test request') => chatInput.parse({ action: 'send', idempotency_key: uuidv7(), message: { id: `msg_${uuidv7()}`, content: { parts: [{ type: 'text', text }] } } })
const rejectsCode = (fn: () => Promise<unknown>, code: string) => assert.rejects(fn, (e: any) => e.data?.code === code)
async function fixture() {
  const orgId = `agent-v1-test-${uuidv7()}`
  const userId = `agent-v1-user-${uuidv7()}`
  const otherId = `agent-v1-other-${uuidv7()}`
  await pool.query('INSERT INTO organization (id,name,slug,metadata) VALUES ($1,$2,$1,$3)', [orgId, 'Example Product', JSON.stringify({ portalModules: { helpCenter: true } })])
  for (const id of [userId, otherId]) await pool.query('INSERT INTO "user" (id,name,email) VALUES ($1,$2,$3)', [id, 'Test User', `${id}@example.invalid`])
  await pool.query("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES ($1,$2,$1,'manager',now())", [otherId, orgId])
  const actor = { orgId, customerId: userId, retentionDays: 30, session: { user: { id: userId, email: `${userId}@example.invalid` } } } as Actor
  const conversationId = uuidv7()
  const cleanup = async () => {
    const { rows } = await pool.query('SELECT id FROM conversation WHERE org_id=$1', [orgId])
    for (const row of rows) {
      await pool.query('DELETE FROM scheduled_task WHERE ref_id=$1 OR ref_id IN (SELECT id FROM agent_run WHERE conversation_id=$1)', [row.id])
      await pool.query('DELETE FROM mastra_messages WHERE thread_id=$1', [row.id])
      await pool.query('DELETE FROM mastra_threads WHERE id=$1', [row.id])
      await pool.query("DELETE FROM conversation_item WHERE conversation_id=$1 AND author_type='agent'", [row.id])
      await pool.query('DELETE FROM agent_run WHERE conversation_id=$1', [row.id])
      await pool.query('DELETE FROM conversation_item WHERE conversation_id=$1', [row.id])
      await pool.query('DELETE FROM message WHERE conversation_id=$1', [row.id])
    }
    for (const table of ['vote', 'comment', 'post_subscription']) await pool.query(`DELETE FROM ${table} WHERE post_id IN (SELECT id FROM post WHERE org_id=$1)`, [orgId])
    for (const table of ['post', 'board', 'help_article', 'help_collection', 'conversation']) await pool.query(`DELETE FROM ${table} WHERE org_id=$1`, [orgId])
    await pool.query('DELETE FROM organization WHERE id=$1', [orgId])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [[userId, otherId]])
  }
  return { orgId, userId, otherId, actor, conversationId, cleanup }
}

test('production inputs preserve text, constrain context and reject forged result parts', () => {
  assert.equal(customerContent.safeParse({ parts: [{ type: 'text', text: 'x'.repeat(4001) }] }).success, false)
  assert.equal(customerContent.safeParse({ parts: [{ type: 'feedback_created' }] }).success, false)
  assert.equal(pageContext.safeParse({ pathname: '//other.example/path' }).success, false)
  assert.equal(pageContext.safeParse({ pathname: '/page?secret=1' }).success, false)
  assert.equal(pageContext.safeParse({ title: 'Example' }).success, true)
  const input = send('  Preserve this text  ')
  assert.equal(input.action === 'send' && input.message.content.parts[0]?.type === 'text' && input.message.content.parts[0].text, '  Preserve this text  ')
})

test('SSE parser handles fragmented CRLF, unicode and multiple data events', async () => {
  const bytes = new TextEncoder().encode('event: text\r\ndata: {"delta":"Hello 👋"}\r\n\r\nevent: finish\ndata: {"lastSeq":2}\n\n')
  const seen: unknown[] = []
  await readAgentEvents(new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close() } }), (name, data) => seen.push([name, data]))
  assert.deepEqual(seen, [['text', { delta: 'Hello 👋' }], ['finish', { lastSeq: 2 }]])
})

test('first-send concurrency, ownership, unchanged idempotency, retries, sequence and timeout fencing', async () => {
  const f = await fixture()
  try {
    const input = send()
    assert.equal(input.action, 'send')
    if (input.action !== 'send') throw new Error('Expected send')
    const attempts = await Promise.all([startRun(runtime, f.conversationId, f.actor, input), startRun(runtime, f.conversationId, f.actor, input)])
    assert.equal(attempts.filter(a => a.duplicate).length, 1)
    const first = attempts[0]!
    assert.equal(first.run.id, attempts[1]!.run.id)
    await rejectsCode(() => startRun(runtime, f.conversationId, { ...f.actor, customerId: f.otherId }, input), 'conversation_not_found')
    await rejectsCode(() => startRun(runtime, f.conversationId, { ...f.actor, orgId: 'default-org' }, input), 'conversation_not_found')
    await rejectsCode(() => startRun(runtime, f.conversationId, f.actor, { ...input, message: { ...input.message, context: { title: 'Changed' } } }), 'idempotency_conflict')
    await rejectsCode(() => startRun(runtime, f.conversationId, f.actor, send('Second input')), 'conversation_busy')
    await failRun(runtime, first.run.id, 'Test failure')
    assert.equal((await startRun(runtime, f.conversationId, f.actor, input)).run.status, 'failed')
    assert.equal((await startRun(runtime, f.conversationId, f.actor, { ...input, idempotency_key: uuidv7() })).duplicate, true)
    const retry = await startRun(runtime, f.conversationId, f.actor, { action: 'retry', idempotency_key: uuidv7(), trigger_item_id: input.message.id })
    assert.notEqual(retry.run.id, first.run.id)
    await transaction(runtime, async client => {
      await lockConversation(client, f.conversationId, f.actor)
      await appendItem(client, { id: uuidv7(), conversationId: f.conversationId, author: 'agent', content: { parts: [{ type: 'text', text: 'Saved reply' }] }, runId: retry.run.id })
      await client.query("UPDATE agent_run SET status='completed',finished_at=now() WHERE id=$1", [retry.run.id])
    })
    await rejectsCode(() => startRun(runtime, f.conversationId, f.actor, { action: 'retry', idempotency_key: uuidv7(), trigger_item_id: input.message.id }), 'retry_not_allowed')
    const { rows: [conversation] } = await pool.query('SELECT last_seq,unread,title FROM conversation WHERE id=$1', [f.conversationId])
    assert.equal(Number(conversation.last_seq), 2)
    assert.equal(conversation.unread, true)
    assert.equal(conversation.title, 'Test request')
    const next = await startRun(runtime, f.conversationId, f.actor, send('New message'))
    await pool.query("UPDATE agent_run SET started_at=now()-interval '3 minutes',deadline_at=now()-interval '1 minute' WHERE id=$1", [next.run.id])
    await transaction(runtime, client => syncRunTask(client, next.run.id))
    await inboxTick(runtime)
    assert.equal((await pool.query('SELECT status FROM agent_run WHERE id=$1', [next.run.id])).rows[0].status, 'failed')
    const oldId = uuidv7()
    await pool.query('INSERT INTO conversation (id,org_id,user_id) VALUES ($1,$2,$3)', [oldId, f.orgId, f.userId])
    await pool.query("INSERT INTO message (id,conversation_id,role,text) VALUES ($1,$2,'user','Old history')", [uuidv7(), oldId])
    await rejectsCode(() => startRun(runtime, oldId, f.actor, send()), 'conversation_not_found')
    await pool.query('DELETE FROM message WHERE conversation_id=$1', [oldId])
  } finally { await f.cleanup() }
})

test('AI visibility is independent of publishing and public module, with no internal citations or tenant leak', async () => {
  const f = await fixture()
  try {
    const collectionId = uuidv7()
    await pool.query("INSERT INTO help_collection (id,org_id,name,icon,visible,position) VALUES ($1,$2,'Test','book-open',true,0)", [collectionId, f.orgId])
    const ids: string[] = []
    for (const [status, aiEnabled] of [['published', true], ['draft', true], ['archived', false]] as const) {
      const id = uuidv7(); ids.push(id)
      await pool.query("INSERT INTO help_article (id,org_id,collection_id,short_id,slug,status,title,content,tsv,position,ai_enabled) VALUES ($1,$2,$3,$4,'export',$5,'Report export','Export as CSV',to_tsvector('english','report export'),0,$6)", [id, f.orgId, collectionId, id.slice(-6), status, aiEnabled])
    }
    const results = await searchHelpArticles(pool, f.orgId, { queries: ['report export'] }, 'http://example.localhost:3000')
    assert.equal(results.articles.length, 2)
    assert.equal(results.articles.find(a => a.article_id === ids[1])?.url, null)
    assert.equal((await searchHelpArticles(pool, 'missing-org', { queries: ['report export'] }, 'http://example.localhost:3000')).articles.length, 0)
    const context = await loadAgentPromptContext(pool, f.actor)
    assert.deepEqual(context.articles.map(article => article.id).sort(), ids.slice(0, 2).sort())
    assert.ok(context.articles.every(article => Object.keys(article).sort().join(',') === 'collectionId,collectionName,description,id,title'))
    assert.doesNotMatch(renderAgentSystemPrompt(context), /Export as CSV/)
    const otherTenant = await loadAgentPromptContext(pool, { ...f.actor, orgId: 'default-org' })
    assert.ok(otherTenant.articles.every(article => !ids.includes(article.id)))
    const tools = feedlogTools(event, f.actor, f.conversationId, uuidv7(), 'input', new AbortController().signal, () => {}, context)
    const call = (name: string, input: unknown) => tools.tools[name]!.execute!(input as any, {} as any) as Promise<any>
    assert.equal((await call('read_help_article', { article_id: ids[1] })).customer_visible, false)
    assert.deepEqual(await tools.sourceUrls(), [], 'an internal article must not become a public navigation link')
    assert.ok((await call('cite_knowledge_sources', { sources: [{ sourceType: 'help_article', id: ids[1] }] })).error)
    await call('read_help_article', { article_id: ids[0] })
    assert.equal((await tools.sourceUrls()).length, 1)
    await call('cite_knowledge_sources', { sources: [{ sourceType: 'help_article', id: ids[0] }] })
    assert.equal((await tools.resultParts()).length, 1)
    {
      const setting = { scope: 'collection' as const, id: collectionId, enabled: false }
      await updateAiTrainingReference(pool, f.orgId, setting)
      assert.equal((await loadAgentPromptContext(pool, f.actor)).knowledgeEnabled, false)
      assert.ok((await call('read_help_article', { article_id: ids[0] })).error, 'already-created tools recheck current gates')
      assert.equal((await tools.resultParts()).length, 0, 'closing a source after reading removes its final citation')
      assert.deepEqual(await tools.citationCandidates(), [], 'closed collections cannot enter citation review')
      assert.deepEqual(await tools.sourceUrls(), [], 'disabled articles must not remain available as navigation links')
      await updateAiTrainingReference(pool, f.orgId, { ...setting, enabled: true })
      assert.equal((await tools.resultParts()).length, 1)
    }
    await pool.query('UPDATE organization SET metadata=$2 WHERE id=$1', [f.orgId, JSON.stringify({ portalModules: { helpCenter: false } })])
    await pool.query('UPDATE help_collection SET visible=false WHERE id=$1', [collectionId])
    await pool.query('UPDATE help_article SET description=$2 WHERE id=$1', [ids[1], 'Internal "export" guide\nMore details'])
    const refreshed = await loadAgentPromptContext(pool, f.actor)
    assert.equal(refreshed.knowledgeEnabled, true)
    assert.deepEqual(refreshed.articles.map(article => article.id).sort(), ids.slice(0, 2).sort())
    const prompt = renderAgentSystemPrompt(refreshed)
    assert.match(prompt, /Start with `search_knowledge_base`/)
    assert.match(prompt, /## Article Catalog/)
    assert.ok(refreshed.articles.some(article => article.description?.includes('Internal')))
    assert.equal((await tools.resultParts()).length, 0)
  } finally { await f.cleanup() }
})

test('website AI Reference gates remove context, reads and final citations while preserving the indexed page', async () => {
  const f = await fixture(), sourceId = uuidv7(), pageId = uuidv7()
  try {
    await pool.query("INSERT INTO ai_training_website(id,org_id,url,name,input_type,frequency) VALUES($1,$2,'https://example.com','Website','website','manual')", [sourceId, f.orgId])
    await pool.query("INSERT INTO ai_training_web_page(id,org_id,website_id,url,metadata,indexed_at) VALUES($1,$2,$3,'https://example.com/guide',jsonb_build_object('title','Widget setup','content','Install the widget.'),now())", [pageId, f.orgId, sourceId])
    const context = await loadAgentPromptContext(pool, f.actor)
    assert.equal(context.websiteSourcesAvailable, true)
    assert.equal(context.knowledgeEnabled, true)
    assert.deepEqual(context.articles, [], 'website knowledge does not require any help articles')
    assert.match(renderAgentSystemPrompt(context), /Start with `search_knowledge_base`/)
    const tools = feedlogTools(event, f.actor, f.conversationId, uuidv7(), 'input', new AbortController().signal, () => {}, context)
    const call = (name: string, input: unknown) => tools.tools[name]!.execute!(input as any, {} as any) as Promise<any>
    assert.equal(tools.tools.cite_help_articles, undefined)
    assert.ok((await call('cite_knowledge_sources', { sources: [{ sourceType: 'web_page', id: pageId }] })).error, 'search-only or unread pages cannot be cited')
    assert.equal((await call('read_web_page', { id: pageId })).content, 'Install the widget.')
    assert.ok((await call('cite_knowledge_sources', { sources: [{ sourceType: 'help_article', id: pageId }] })).error, 'a page cannot be cited as a help article')
    await call('cite_knowledge_sources', { sources: [{ sourceType: 'web_page', id: pageId }] })
    assert.equal((await tools.resultParts()).length, 1)
    for (let i = 0; i < 7; i++) {
      const extra = uuidv7()
      await pool.query("INSERT INTO ai_training_web_page(id,org_id,website_id,url,metadata,indexed_at) VALUES($1,$2,$3,$4,jsonb_build_object('title','Other documentation','content','Another product fact.'),now())", [extra, f.orgId, sourceId, `https://example.com/other-${i}`])
      await call('read_web_page', { id: extra })
    }
    const selected = await tools.citationCandidates()
    assert.deepEqual(selected.map(source => source.id), [pageId], 'reading eight pages must not expand one explicitly selected citation')
    await pool.query("UPDATE ai_training_web_page SET metadata=jsonb_set(metadata,'{content}',to_jsonb('Install the widget. This instruction has been withdrawn.'::text)) WHERE id=$1", [pageId])
    assert.deepEqual(await tools.citationCandidates(), [], 'changed scope invalidates stale evidence even when the old sentence remains')
    await call('read_web_page', { id: pageId })
    assert.deepEqual(await tools.citationCandidates(), [], 'rereading does not silently replace the previously selected source snapshot')
    await pool.query("UPDATE ai_training_web_page SET metadata=jsonb_set(metadata,'{content}',to_jsonb('Install the widget.'::text)) WHERE id=$1", [pageId])
    await call('read_web_page', { id: pageId })
    assert.ok((await call('cite_knowledge_sources', { sources: Array(4).fill({ sourceType: 'web_page', id: pageId }) })).error)
    assert.deepEqual((await tools.citationCandidates()).map(source => source.id), [pageId], 'an invalid tool call must preserve the last valid selection')
    await pool.query("UPDATE ai_training_web_page SET metadata=jsonb_set(metadata,'{title}',to_jsonb('A different product'::text)) WHERE id=$1", [pageId])
    await call('read_web_page', { id: pageId })
    assert.deepEqual(await tools.citationCandidates(), [], 'a reread cannot silently change the title scope of a previous citation')
    await pool.query("UPDATE ai_training_web_page SET metadata=jsonb_set(metadata,'{title}',to_jsonb('Widget setup'::text)) WHERE id=$1", [pageId])
    await call('read_web_page', { id: pageId })
    {
      const setting = { scope: 'source' as const, id: sourceId, enabled: false }
      await updateAiTrainingReference(pool, f.orgId, setting)
      assert.equal((await loadAgentPromptContext(pool, f.actor)).websiteSourcesAvailable, false)
      assert.ok((await call('read_web_page', { id: pageId })).error)
      assert.equal((await tools.resultParts()).length, 0)
      assert.deepEqual(await tools.citationCandidates(), [], 'closed websites cannot enter citation review')
      assert.deepEqual(await tools.sourceUrls(), [], 'a closed website must not remain available as a navigation link')
      assert.ok((await pool.query('SELECT indexed_at FROM ai_training_web_page WHERE id=$1', [pageId])).rows[0].indexed_at)
      await updateAiTrainingReference(pool, f.orgId, { ...setting, enabled: true })
      assert.equal((await tools.resultParts()).length, 1)
    }
  } finally {
    await removeWebSource(pool, f.orgId, sourceId)
    await f.cleanup()
  }
})

test('feedback correction enforces ten-minute/community limits and falls back to owned comments; writes fence expired runs', async () => {
  const f = await fixture()
  try {
    const boardId = uuidv7()
    await pool.query("INSERT INTO board (id,org_id,name) VALUES ($1,$2,'Suggestions')", [boardId, f.orgId])
    const execution = await startRun(runtime, f.conversationId, f.actor, send())
    await memory.createThread({ threadId: f.conversationId, resourceId: `${f.orgId}:${f.conversationId}`, title: 'Test' })
    const context = await loadAgentPromptContext(pool, f.actor)
    const bundle = feedlogTools(event, f.actor, f.conversationId, execution.run.id, execution.item.id, new AbortController().signal, () => {}, context)
    const call = (name: string, input: unknown) => bundle.tools[name]!.execute!(input as any, {} as any) as Promise<any>
    const created = await call('create_feedback', { title: 'Export', content: 'I need CSV export.', board_id: boardId })
    assert.ok(created.feedback_id, JSON.stringify(created))
    assert.equal((await call('create_feedback', { title: 'Export', content: 'I need CSV export.', board_id: boardId })).feedback_id, created.feedback_id)
    const id = created.feedback_id
    const detail = await call('get_feedback', { feedback_id: id })
    assert.ok(detail.feedback, JSON.stringify(detail))
    assert.equal(detail.feedback.editable, true)
    assert.equal((await call('update_feedback', { feedback_id: id, title: 'CSV export' })).changed, true)
    assert.equal((await call('get_feedback', { feedback_id: id })).feedback.content, 'I need CSV export.')
    await pool.query('INSERT INTO vote (post_id,user_id) VALUES ($1,$2)', [id, f.otherId])
    assert.equal((await call('get_feedback', { feedback_id: id })).feedback.editable, false)
    assert.ok((await call('update_feedback', { feedback_id: id, title: 'Forbidden edit' })).error)
    await pool.query('DELETE FROM vote WHERE post_id=$1', [id])
    await pool.query("UPDATE post SET created_at=now()-interval '11 minutes' WHERE id=$1", [id])
    assert.ok((await call('update_feedback', { feedback_id: id, title: 'Too late' })).error)
    const comment = await call('add_feedback_comment', { feedback_id: id, content: 'I also need filenames.' })
    assert.ok(comment.comment_id)
    assert.equal((await call('update_feedback_comment', { comment_id: comment.comment_id, content: 'I also need dates.' })).comment_text, 'I also need dates.')
    assert.equal((await call('get_feedback', { feedback_id: id })).comments.length, 1)
    const unchanged = await call('update_feedback_comment', { comment_id: comment.comment_id, content: 'I also need dates.' })
    assert.equal(unchanged.changed, false)
    assert.equal(unchanged.type, undefined)
    await call('upvote_and_subscribe_feedback', { feedback_id: id })
    await call('upvote_and_subscribe_feedback', { feedback_id: id })
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM vote WHERE post_id=$1 AND user_id=$2', [id, f.actor.customerId])).rows[0].n, 1)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM post_subscription WHERE post_id=$1 AND user_id=$2', [id, f.actor.customerId])).rows[0].n, 1)
    const cards = (await bundle.resultParts()).filter(part => 'feedback_id' in part)
    assert.ok(cards.every(part => 'vote_count' in part && part.vote_count === 1 && part.has_voted))
    await pool.query("UPDATE agent_run SET started_at=now()-interval '3 minutes',deadline_at=now()-interval '1 minute' WHERE id=$1", [execution.run.id])
    assert.ok((await call('update_feedback_comment', { comment_id: comment.comment_id, content: 'Expired run' })).error)
    assert.equal((await pool.query('SELECT content FROM comment WHERE id=$1', [comment.comment_id])).rows[0].content, 'I also need dates.')
    await transaction(runtime, async client => {
      await client.query("UPDATE agent_run SET status='running',error=NULL,finished_at=NULL,deadline_at=clock_timestamp()+interval '100 milliseconds' WHERE id=$1", [execution.run.id])
      await client.query('SELECT pg_sleep(0.15)')
      await recoverLocked(client, await lockConversation(client, f.conversationId, f.actor))
      assert.equal((await client.query('SELECT status FROM agent_run WHERE id=$1', [execution.run.id])).rows[0].status, 'failed')
    })
  } finally { await f.cleanup() }
})


test('handoff tool commits once, stops the active run and fences later feedback writes', async () => {
  const f = await fixture()
  try {
    const input = send('A human please')
    const run = await startRun(runtime, f.conversationId, f.actor, input)
    const controller = new AbortController()
    const context = await loadAgentPromptContext(pool, f.actor)
    const bundle = feedlogTools(event, f.actor, f.conversationId, run.run!.id, run.item.id, controller.signal, () => {}, context, () => controller.abort())
    const customerNotice = 'درخواست شما به تیم پشتیبانی ارجاع داده شد. می‌توانید جزئیات بیشتری را همین‌جا ارسال کنید.'
    const result = await bundle.tools.handoff_to_human.execute!({ reason: 'user_requested', customer_notice: customerNotice }, {} as any)
    assert.deepEqual(result, { handoff: true, status: 'open', stop: true })
    assert.equal(controller.signal.aborted, true)
    assert.equal((await pool.query('SELECT status FROM conversation WHERE id=$1', [f.conversationId])).rows[0].status, 'open')
    await assert.rejects(() => bundle.tools.add_feedback_comment.execute!({ feedback_id: uuidv7(), content: 'Late write' }, {} as any))
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM conversation_item WHERE conversation_id=$1 AND author_type='system'", [f.conversationId])).rows[0].count, 1)
    const saved = (await pool.query("SELECT * FROM conversation_item WHERE conversation_id=$1 AND author_type='system'", [f.conversationId])).rows[0]
    assert.equal(saved.content.parts[0].customerNotice, customerNotice)
    assert.equal(publicItem(saved)?.customerNotice, customerNotice)
    assert.deepEqual(publicItem(saved)?.content, { parts: [{ type: 'text', text: customerNotice }] })
    await bundle.tools.handoff_to_human.execute!({ reason: 'user_requested', customer_notice: 'A different confirmation must not replace the saved text.' }, {} as any)
    assert.deepEqual((await pool.query("SELECT * FROM conversation_item WHERE conversation_id=$1 AND author_type='system'", [f.conversationId])).rows, [saved])
  } finally { await f.cleanup() }
})

test('feedback followed by handoff preserves one visible receipt before the notice, including replay', async () => {
  const f = await fixture()
  try {
    const boardId = uuidv7()
    await pool.query("INSERT INTO board (id,org_id,name) VALUES ($1,$2,'Suggestions')", [boardId, f.orgId])
    const execution = await startRun(runtime, f.conversationId, f.actor, send('Please record the missing export option and let me speak to a person.'))
    await memory.createThread({ threadId: f.conversationId, resourceId: `${f.orgId}:${f.conversationId}`, title: 'Test' })
    const context = await loadAgentPromptContext(pool, f.actor)
    const controller = new AbortController()
    const bundle = feedlogTools(event, f.actor, f.conversationId, execution.run.id, execution.item.id, controller.signal, () => {}, context, () => controller.abort())
    const created = await bundle.tools.create_feedback.execute!({ board_id: boardId, title: 'Export option', content: 'I need an option to export my reports.' }, {} as any) as any
    const feedbackId = created.feedback.feedback_id
    assert.equal((await pool.query('SELECT source_conversation_id FROM post WHERE id=$1', [feedbackId])).rows[0].source_conversation_id, f.conversationId)
    const call = () => bundle.tools.handoff_to_human.execute!({ reason: 'user_requested', customer_notice: HANDOFF_NOTICE }, {} as any)
    assert.deepEqual(await call(), { handoff: true, status: 'open', stop: true })
    assert.equal(controller.signal.aborted, true)
    const items = () => pool.query('SELECT * FROM conversation_item WHERE conversation_id=$1 ORDER BY seq', [f.conversationId])
    const { rows } = await items()
    assert.deepEqual(rows.map(row => row.author_type), ['customer', 'agent', 'system'])
    const receipt = publicItem(rows[1])!
    assert.equal(receipt.agentRunId, execution.run.id)
    assert.deepEqual((receipt.content as any).parts.map((part: any) => [part.type, part.feedback_id]), [['feedback_created', feedbackId]])
    assert.equal(publicItem(rows[2])!.notice, 'handoff')
    await call()
    assert.equal((await items()).rows.length, 3)
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM post WHERE source_conversation_id=$1', [f.conversationId])).rows[0].count, 1)
  } finally { await f.cleanup() }
})

test('handoff recovers write, task and receipt-refresh failures without customer intervention', async () => {
  for (const failure of ['transition', 'task', 'receipt-refresh']) {
    const f = await fixture()
    const originalConnect = pool.connect
    const originalQuery = pool.query
    let failures = 0
    try {
      const boardId = uuidv7()
      await pool.query("INSERT INTO board (id,org_id,name) VALUES ($1,$2,'Suggestions')", [boardId, f.orgId])
      const execution = await startRun(runtime, f.conversationId, f.actor, send())
      await memory.createThread({ threadId: f.conversationId, resourceId: `${f.orgId}:${f.conversationId}`, title: 'Test' })
      const context = { ...await loadAgentPromptContext(pool, f.actor), supportEmail: 'support@example.invalid' }
      const controller = new AbortController()
      const bundle = feedlogTools(event, f.actor, f.conversationId, execution.run.id, execution.item.id, controller.signal, () => {}, context, () => controller.abort())
      await bundle.tools.create_feedback.execute!({ board_id: boardId, title: 'Export option', content: 'I need an export option.' }, {} as any)
      // Exercise a real aborted transaction, persistent task failure and an unavailable card refresh.
      if (failure === 'task') await pool.query("UPDATE agent_run SET started_at=clock_timestamp()-interval '3 minutes',deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1", [execution.run.id])
      pool.query = ((text: string, ...args: any[]) => {
        if (failure === 'receipt-refresh' && text.includes('FROM post p LEFT JOIN board b')) {
          failures++
          return Promise.reject(new Error('Simulated receipt refresh failure'))
        }
        return (originalQuery as any).call(pool, text, ...args)
      }) as any
      pool.connect = ((callback?: (...args: any[]) => void) => {
        if (callback) return (originalConnect as any).call(pool, callback)
        return (originalConnect as any).call(pool).then((client: any) => {
          const query = client.query
          const release = client.release
          client.query = ((text: string, ...args: any[]) => {
            if ((failure === 'transition' && !failures && text.startsWith("UPDATE conversation SET status='open'"))
              || (failure === 'task' && text.startsWith('INSERT INTO scheduled_task') && !text.includes("'inbox_handoff_email'"))) {
              failures++
              return (query as any).call(client, 'SELECT 1/0')
            }
            return (query as any).call(client, text, ...args)
          }) as any
          client.release = (...args: any[]) => { client.query = query; client.release = release; return release.apply(client, args as any) }
          return client
        })
      }) as any
      const result = await bundle.tools.handoff_to_human.execute!({ reason: 'user_requested', customer_notice: HANDOFF_NOTICE }, {} as any) as any
      pool.connect = originalConnect
      pool.query = originalQuery
      assert.ok(failures > 0, failure)
      assert.deepEqual(result, { handoff: true, status: 'open', stop: true })
      assert.equal(controller.signal.aborted, true)
      assert.deepEqual((await pool.query('SELECT status,state_due_at FROM conversation WHERE id=$1', [f.conversationId])).rows[0], { status: 'open', state_due_at: null })
      assert.equal((await pool.query('SELECT status FROM agent_run WHERE id=$1', [execution.run.id])).rows[0].status, 'cancelled')
      const { rows } = await pool.query('SELECT * FROM conversation_item WHERE conversation_id=$1 ORDER BY seq', [f.conversationId])
      assert.deepEqual(rows.map(row => row.author_type), ['customer', 'agent', 'system'])
      assert.equal(rows[1].content.parts[0].type, 'feedback_created')
      assert.equal(rows[2].content.parts[0].reason, 'user_requested')
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM post WHERE source_conversation_id=$1', [f.conversationId])).rows[0].count, 1)
      await bundle.tools.handoff_to_human.execute!({ reason: 'user_requested', customer_notice: HANDOFF_NOTICE }, {} as any)
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM conversation_item WHERE conversation_id=$1', [f.conversationId])).rows[0].count, 3)
      await pool.query("UPDATE scheduled_task SET schedule_at=clock_timestamp()-interval '1 minute' WHERE ref_id=$1 OR ref_id=$2", [f.conversationId, execution.run.id])
      await inboxTick(runtime)
      assert.equal((await pool.query('SELECT status FROM conversation WHERE id=$1', [f.conversationId])).rows[0].status, 'open')
    } finally { pool.connect = originalConnect; pool.query = originalQuery; await f.cleanup() }
  }
})


test('rule handoffs validate configured IDs, preserve rule snapshots and hide details from Widget', async () => {
  for (const ruleId of ['builtin-billing', 'custom-on']) {
    const f = await fixture()
    try {
      await pool.query('INSERT INTO organization_widget (org_id,disabled_builtins,custom_rules) VALUES ($1,$2,$3)', [f.orgId,
        JSON.stringify(['builtin-account-access']), JSON.stringify([
          { id: 'custom-on', scenario: 'Customer requests a team migration', enabled: true },
          { id: 'custom-off', scenario: 'Disabled scenario', enabled: false },
        ])])
      const run = await startRun(runtime, f.conversationId, f.actor, send('Please help with this support case'))
      const context = await loadAgentPromptContext(pool, f.actor)
      const bundle = feedlogTools(event, f.actor, f.conversationId, run.run!.id, run.item.id, new AbortController().signal, () => {}, context)
      const call = (input: any) => bundle.tools.handoff_to_human.execute!({ customer_notice: HANDOFF_NOTICE, ...input }, {} as any)
      for (const invalid of [undefined, 'unknown', 'builtin-account-access', 'custom-off']) {
        assert.ok('error' in await call({ reason: 'support_rule', rule_id: invalid }))
      }
      assert.ok('error' in await call({ reason: 'user_requested', rule_id: ruleId }))
      assert.equal((await pool.query('SELECT status FROM conversation WHERE id=$1', [f.conversationId])).rows[0].status, 'ai_handling')
      assert.deepEqual(await call({ reason: 'support_rule', rule_id: ruleId }), { handoff: true, status: 'open', stop: true })
      const saved = async () => (await pool.query("SELECT * FROM conversation_item WHERE conversation_id=$1 AND author_type='system'", [f.conversationId])).rows
      const original = await saved()
      assert.equal(original.length, 1)
      const part = original[0].content.parts[0]
      assert.equal(part.reason, 'support_rule')
      assert.deepEqual(part.rule, context.supportRules.find(rule => rule.id === ruleId))
      const visible = JSON.stringify(publicItem(original[0]))
      assert.ok(!visible.includes(ruleId))
      assert.ok(!visible.includes(part.rule.scenario))
      await pool.query("UPDATE organization_widget SET disabled_builtins=$2,custom_rules='[]'::jsonb WHERE org_id=$1", [f.orgId, JSON.stringify(['builtin-billing', 'builtin-account-access', 'builtin-privacy-legal'])])
      assert.deepEqual((await loadAgentPromptContext(pool, f.actor)).supportRules, [])
      await call({ reason: 'support_rule', rule_id: ruleId })
      assert.deepEqual(await saved(), original)
    } finally { await f.cleanup() }
  }
})


test('Widget hides internal lifecycle events and exposes only a short handoff notice', () => {
  for (const kind of ['closed', 'reopened', 'snoozed', 'resumed', 'priority_changed', 'customer_resumed', 'handoff']) {
    const item = { id: 'event', seq: 2, author_type: 'system', created_at: new Date().toISOString(), content: { parts: [{ type: 'system_event', kind, reason: 'manual', fromStatus: 'open', toStatus: 'closed' }] } }
    const visible = publicItem(item)
    if (kind === 'handoff') {
      assert.equal(visible?.notice, 'handoff')
      assert.deepEqual(visible?.content, { parts: [{ type: 'text', text: HANDOFF_NOTICE }] })
    } else assert.equal(visible, null)
    assert.equal(item.content.parts[0]!.kind, kind)
  }
})


test('production Agent preparation uses committed business history and makes the same context available to recovery and citations', async () => {
  const f = await fixture()
  const savedKey = process.env.OPENAI_API_KEY, savedModel = process.env.OPENAI_TEXT_MODEL
  process.env.OPENAI_API_KEY = 'synthetic-test-key'; process.env.OPENAI_TEXT_MODEL = 'mock'
  try {
    const first = await startRun(runtime, f.conversationId, f.actor, send('I use Document Translator with a scanned PDF.'))
    await completeRun(runtime, f.conversationId, f.actor, first.run.id, uuidv7(), { parts: [{ type: 'text', text: 'Plus is required. Would you like me to involve a person?' }] })
    const second = await startRun(runtime, f.conversationId, f.actor, send('Okay.'))
    const prepared = await prepareAgent(event, f.actor, f.conversationId, second.run, second.item, new AbortController().signal, () => {})
    assert.equal(prepared.historySize, false, 'raw Mastra tool messages must not occupy the conversation window')
    assert.deepEqual(prepared.conversationContext.messages.map(message => message.role), ['user', 'assistant', 'user'])
    assert.match(JSON.stringify(prepared.conversationContext), /Would you like me to involve a person/)
    assert.match(JSON.stringify(prepared.conversationContext), /scanned PDF/)
    const tools = await prepared.agent.listTools()
    const page = await tools.read_conversation_history!.execute!({ turns: 2 }, {} as any) as any
    assert.deepEqual(page.items.map((item: any) => item.author_type), ['customer', 'agent', 'customer'])
    const chunk = await tools.read_conversation_history!.execute!({ itemSeq: 2, offset: 0 }, {} as any) as any
    assert.match(chunk.text, /Would you like me to involve a person/)
  } finally {
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedKey
    if (savedModel === undefined) delete process.env.OPENAI_TEXT_MODEL; else process.env.OPENAI_TEXT_MODEL = savedModel
    await f.cleanup()
  }
})

test('repeated handoff and reopening preserve successful actions when a later action fails', async () => {
  const f = await fixture()
  try {
    const boardId = uuidv7()
    await pool.query("INSERT INTO board(id,org_id,name) VALUES($1,$2,'Suggestions')", [boardId, f.orgId])
    await memory.createThread({ threadId: f.conversationId, resourceId: `${f.orgId}:${f.conversationId}`, title: 'Test' })
    const context = await loadAgentPromptContext(pool, f.actor)
    const first = await startRun(runtime, f.conversationId, f.actor, send('Save my suggestion and transfer me.'))
    const bundle = feedlogTools(event, f.actor, f.conversationId, first.run.id, first.item.id, new AbortController().signal, () => {}, context)
    const created = await bundle.tools.create_feedback!.execute!({ board_id: boardId, title: 'Export date filter', content: 'Allow a date range when exporting comments.' }, {} as any) as any
    const feedbackId = created.feedback.feedback_id
    const failed = await bundle.tools.create_feedback!.execute!({ board_id: uuidv7(), title: 'Invalid board', content: 'Must not create a second record.' }, {} as any) as any
    assert.match(failed.error, /Board is not available/)
    const transfer = () => bundle.tools.handoff_to_human.execute!({ reason: 'user_requested', customer_notice: HANDOFF_NOTICE }, {} as any)
    await transfer(); await transfer()
    let saved = (await pool.query('SELECT * FROM conversation WHERE id=$1', [f.conversationId])).rows[0]
    await staffCommand(runtime, f.conversationId, f.orgId, f.otherId, { requestId: uuidv7(), expectedLastSeq: Number(saved.last_seq), action: 'close' })
    const second = await startRun(runtime, f.conversationId, f.actor, send('Vote for that suggestion and transfer me again.'))
    assert.equal(second.mode, 'ai')
    const again = feedlogTools(event, f.actor, f.conversationId, second.run.id, second.item.id, new AbortController().signal, () => {}, context)
    const vote = await again.tools.upvote_and_subscribe_feedback!.execute!({ feedback_id: feedbackId }, {} as any) as any
    assert.equal(vote.type, 'feedback_upvoted')
    assert.match((await again.tools.upvote_and_subscribe_feedback!.execute!({ feedback_id: uuidv7() }, {} as any) as any).error, /Feedback not found/)
    await again.tools.handoff_to_human.execute!({ reason: 'user_requested', customer_notice: HANDOFF_NOTICE }, {} as any)
    saved = (await pool.query('SELECT * FROM conversation WHERE id=$1', [f.conversationId])).rows[0]
    await staffCommand(runtime, f.conversationId, f.orgId, f.otherId, { requestId: uuidv7(), expectedLastSeq: Number(saved.last_seq), action: 'close' })
    const input = send('Was the suggestion saved and voted for? Do not repeat either action.')
    const third = await startRun(runtime, f.conversationId, f.actor, input)
    const history = await readConversationContext(pool, f.actor, f.conversationId, third.item.seq)
    const receipts = history.items.flatMap(item => item.content.parts).filter(part => 'feedback_id' in part)
    assert.deepEqual(receipts.map(part => [part.type, 'feedback_id' in part && part.feedback_id]), [['feedback_created', feedbackId], ['feedback_upvoted', feedbackId]])
    const exact = await readConversationContext(pool, f.actor, f.conversationId, third.item.seq, { itemSeq: Number(history.items.find(item => item.id === `handoff-results:${second.run.id}`)!.seq) })
    assert.equal(JSON.parse(exact.text!).content.parts[0].type, 'feedback_upvoted')
    assert.equal((await pool.query('SELECT count(*)::int count FROM post WHERE source_conversation_id=$1', [f.conversationId])).rows[0].count, 1)
    assert.equal((await pool.query('SELECT vote_count FROM post WHERE id=$1', [feedbackId])).rows[0].vote_count, 1)
    assert.equal((await pool.query('SELECT count(*)::int count FROM vote WHERE post_id=$1', [feedbackId])).rows[0].count, 1)
    assert.equal((await startRun(runtime, f.conversationId, f.actor, input)).duplicate, true)
    assert.equal((await pool.query('SELECT count(*)::int count FROM agent_run WHERE conversation_id=$1', [f.conversationId])).rows[0].count, 3)
  } finally { await f.cleanup() }
})

test('image observations persist through production preparation, follow-ups and handoff reopening without resending pixels', async () => {
  const f = await fixture()
  const env = { ...process.env }, fetchBefore = globalThis.fetch
  const globals = globalThis as any, blobBefore = globals.blobStorage, configBefore = globals.useRuntimeConfig
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2kAAAAASUVORK5CYII=', 'base64')
  const key = `uploads/${f.orgId}/diagnostic.png`
  let reads = 0, visionCalls = 0
  Object.assign(process.env, { OPENAI_API_KEY: 'synthetic-test-key', OPENAI_TEXT_MODEL: 'mock', OPENAI_BASE_URL: 'https://example.invalid/v1' })
  globals.useRuntimeConfig = () => ({ public: { uploadPrefix: 'uploads' } })
  globals.blobStorage = { head: async (path: string) => path === key ? { size: png.length, contentType: 'image/png', httpEtag: 'test-etag' } : null,
    driver: { getArrayBuffer: async () => { reads++; return png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) } } }
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /^https:\/\/example\.invalid\/v1\/chat\/completions$/)
    const request = JSON.parse(init!.body as string)
    assert.match(JSON.stringify(request.messages), /data:image\/png;base64,/)
    visionCalls++
    return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ images: [{ image: 1, observations: 'Case IMG-QA-846, task exp-1295, error E728. Region eu-west-2. Refund not issued.', uncertainty: '' }] }) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } })
  }
  try {
    const input = chatInput.parse({ action: 'send', idempotency_key: uuidv7(), message: { id: uuidv7(), content: { parts: [{ type: 'text', text: 'Read the diagnostic.' }, { type: 'image', storage_key: key }] } } })
    const first = await startRun(runtime, f.conversationId, f.actor, input)
    await prepareAgent(event, f.actor, f.conversationId, first.run, first.item, new AbortController().signal, () => {})
    const firstHistory = await readConversationContext(pool, f.actor, f.conversationId, first.item.seq)
    assert.match(JSON.stringify(firstHistory.items[0]!.image_analysis), /IMG-QA-846/)
    await completeRun(runtime, f.conversationId, f.actor, first.run.id, uuidv7(), { parts: [{ type: 'text', text: 'The diagnostic reports a failure.' }] })
    const second = await startRun(runtime, f.conversationId, f.actor, send('What was its task ID?'))
    const prepared = await prepareAgent(event, f.actor, f.conversationId, second.run, second.item, new AbortController().signal, () => {})
    assert.match(JSON.stringify(prepared.conversationContext), /exp-1295/)
    assert.equal(visionCalls, 1)
    assert.equal(reads, 1, 'ordinary follow-ups reuse observations without downloading the original image')
    const tools = await prepared.agent.listTools()
    await assert.rejects(() => tools.read_conversation_images!.execute!({ keys: ['uploads/foreign/diagnostic.png'], question: 'Read it' }, {} as any), /not found/)
    const original = await tools.read_conversation_images!.execute!({ keys: [key], question: 'Check the bottom-right region in the original.' }, {} as any) as any
    assert.match(JSON.stringify(original.observations), /eu-west-2/)
    assert.equal(visionCalls, 2)
    await prepared.agent.listTools().then(tools => tools.handoff_to_human!.execute!({ reason: 'user_requested', customer_notice: HANDOFF_NOTICE }, {} as any))
    const saved = (await pool.query('SELECT last_seq FROM conversation WHERE id=$1', [f.conversationId])).rows[0]
    await staffCommand(runtime, f.conversationId, f.orgId, f.otherId, { requestId: uuidv7(), expectedLastSeq: Number(saved.last_seq), action: 'close' })
    const reopened = await startRun(runtime, f.conversationId, f.actor, send('Back again. Which case and error were in my image?'))
    const after = await prepareAgent(event, f.actor, f.conversationId, reopened.run, reopened.item, new AbortController().signal, () => {})
    assert.match(JSON.stringify(after.conversationContext), /IMG-QA-846/)
    assert.match(JSON.stringify(after.conversationContext), /E728/)
    assert.equal(visionCalls, 2, 'reopening must not repeat analysis of already extracted facts')
    const { rows: messages } = await pool.query('SELECT content FROM mastra_messages WHERE thread_id=$1', [f.conversationId])
    assert.equal(messages.length, 1)
    assert.doesNotMatch(JSON.stringify(messages), /data:image|iVBORw0KGgo/)
    await assert.rejects(readConversationContext(pool, { ...f.actor, orgId: 'foreign' }, f.conversationId, reopened.item.seq), /not accessible/)
  } finally {
    process.env = env; globalThis.fetch = fetchBefore
    if (blobBefore === undefined) delete globals.blobStorage; else globals.blobStorage = blobBefore
    if (configBefore === undefined) delete globals.useRuntimeConfig; else globals.useRuntimeConfig = configBefore
    await f.cleanup()
  }
})
