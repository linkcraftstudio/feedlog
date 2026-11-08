/* eslint-disable @typescript-eslint/no-explicit-any -- Fixtures cover partial runtime contexts, invalid inputs and heterogeneous tool results. */
import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { uuidv7 } from 'uuidv7'
import { createError } from 'h3'
import { drizzle } from 'drizzle-orm/node-postgres'
import { customerContent, contentSchema } from '../shared/agent/content'
import { historyProcessor } from '../server/lib/agent/agent'
import { agentRuntime, type Actor } from '../server/lib/agent/runtime'
import { startRun, failRun } from '../server/lib/agent/conversations'
import { collectConversationReply } from '../server/lib/agent/stream'
import { renderAgentSystemPrompt, type AgentPromptContext } from '../server/lib/agent/prompts/system'
import { loadAgentPromptContext } from '../server/lib/agent/prompts/context'
import { feedlogTools } from '../server/lib/agent/tools'
import { WIDGET_BUILTIN_RULE_IDS } from '../shared/constants/widget-rules'
import { stripMarkdown } from '../shared/utils/markdown'
import { searchSimilarByText } from '../server/utils/similar'
import { assertGuestMay } from '../server/utils/guest'

const embeddingWrites: string[] = []
Object.assign(globalThis, {
  createError, stripMarkdown, searchSimilarByText, assertGuestMay,
  createDomainEvent: (input: unknown) => input, publishDomainEvent: () => {},
  useDB: () => drizzle(pool),
  isEmbeddingEnabled: () => false,
  generatePostEmbedding: async (id: string, orgId: string, title: string, content: string, contentHash: string) => {
    const { rows: [saved] } = await pool.query('SELECT org_id,title,content,content_hash FROM post WHERE id=$1', [id])
    assert.deepEqual(saved, { org_id: orgId, title, content, content_hash: contentHash })
    embeddingWrites.push(id)
  },
})
const event = { waitUntil: (task: Promise<unknown>) => task, path: '/', context: {}, node: { req: { headers: { host: 'localhost:3000' }, url: '/' } } } as any
const runtime = agentRuntime(event)
const { pool } = runtime
assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL!).hostname), 'Integration tests require a local database')
after(() => runtime.close())

test('prompt and tools omit unavailable knowledge, creation, voting and empty configuration', () => {
  const context: AgentPromptContext = {
    productName: 'Example Product', boards: [], supportEmail: ' ', supportRules: [],
    knowledgeEnabled: false, articles: [], feedback: { create: false, vote: false, subscribe: true, commentScope: 'own' },
  }
  const prompt = renderAgentSystemPrompt(context)
  assert.match(prompt, /Example Product/)
  assert.match(prompt, /handoff_to_human/)
  assert.match(prompt, /only to their own feedback/)
  for (const text of ['### Product Questions', '## Article Catalog', '**Create:**', '**Vote', '**Available boards**', 'Use a vote for simple agreement.', 'configured situations:', 'undefined', '{{']) assert.equal(prompt.includes(text), false, text)
  const bundle = feedlogTools({} as any, {} as Actor, 'conversation', 'run', 'trigger', new AbortController().signal, () => {}, context)
  assert.deepEqual(Object.keys(bundle.tools).sort(), ['add_feedback_comment', 'get_feedback', 'handoff_to_human', 'search_feedback', 'update_feedback', 'update_feedback_comment'])
})

test('prompt keeps product configuration beside its rules and distinguishes admin subscriptions', () => {
  const context: AgentPromptContext = {
    productName: 'Example Product',
    boards: [{ id: 'board-1', name: 'Suggestions', description: 'New product capabilities' }],
    supportEmail: 'support@example.invalid', supportRules: [{ id: 'invoice-correction', scenario: 'the customer requests an invoice correction' }],
    knowledgeEnabled: true, articles: [{ id: 'article-1', title: 'Product guide', description: 'Getting started' }], feedback: { create: true, vote: true, subscribe: true, commentScope: 'all' },
  }
  const prompt = renderAgentSystemPrompt(context)
  assert.ok(prompt.indexOf('### Feedback') >= 0)
  assert.ok(prompt.indexOf('board-1') > prompt.indexOf('### Feedback'))
  assert.match(prompt, /reason=support_rule/)
  assert.match(prompt, /Suggestions \(ID: board-1\) — New product capabilities/)
  assert.match(prompt, /\*\*Vote and subscribe:\*\*/)
  const adminPrompt = renderAgentSystemPrompt({ ...context, feedback: { ...context.feedback, subscribe: false } })
  assert.match(adminPrompt, /\*\*Vote:\*\*/)
  assert.doesNotMatch(adminPrompt, /\*\*Vote and subscribe:\*\*/)
})

test('prompt context reads tenant configuration fresh and includes only enabled support rules and available articles', async () => {
  const orgId = `agent-prompt-test-${uuidv7()}`
  const boardId = uuidv7()
  const collectionId = uuidv7()
  const articleId = uuidv7()
  const actor = { orgId, customerId: 'prompt-test-customer', session: { user: { isAnonymous: true } } } as unknown as Actor
  await pool.query('INSERT INTO organization (id,name,slug,metadata) VALUES ($1,$2,$1,$3)', [orgId, 'Prompt Test', JSON.stringify({ portalModules: { helpCenter: true }, guest: { allowPost: true } })])
  try {
    await pool.query('INSERT INTO board (id,org_id,name,description) VALUES ($1,$2,$3,$4)', [boardId, orgId, 'Test Board', 'Specific test scope'])
    const defaults = await loadAgentPromptContext(pool, actor)
    assert.equal(defaults.productName, 'Prompt Test')
    assert.equal(defaults.supportRules.length, WIDGET_BUILTIN_RULE_IDS.length)
    assert.equal(defaults.knowledgeEnabled, false)
    assert.deepEqual(defaults.articles, [])
    assert.deepEqual(defaults.boards.map(board => board.id), [boardId])
    assert.equal(defaults.feedback.create, true)
    assert.equal(defaults.feedback.vote, false)
    assert.equal(defaults.feedback.commentScope, 'own')
    await pool.query('INSERT INTO organization_widget (org_id,support_email,disabled_builtins,custom_rules) VALUES ($1,$2,$3,$4)', [orgId, 'team@example.invalid', JSON.stringify(WIDGET_BUILTIN_RULE_IDS), JSON.stringify([{ id: 'on', scenario: 'an enabled custom case', enabled: true }, { id: 'off', scenario: 'a disabled custom case', enabled: false }])])
    await pool.query('INSERT INTO help_collection (id,org_id,name,icon,visible,position) VALUES ($1,$2,$3,$4,true,0)', [collectionId, orgId, 'Test Guides', 'book-open'])
    await pool.query("INSERT INTO help_article (id,org_id,collection_id,short_id,slug,status,title,content,tsv,position) VALUES ($1,$2,$3,'prmpt1','test-guide','published','Test guide','Test content',to_tsvector('english','Test guide Test content'),0)", [articleId, orgId, collectionId])
    const enabled = await loadAgentPromptContext(pool, actor)
    assert.equal(enabled.supportEmail, 'team@example.invalid')
    assert.deepEqual(enabled.supportRules, [{ id: 'on', scenario: 'an enabled custom case' }])
    assert.equal(enabled.knowledgeEnabled, true)
    assert.deepEqual(enabled.articles, [{ id: articleId, title: 'Test guide', description: null }])
    const bundle = feedlogTools(event, actor, 'conversation', 'run', 'trigger', new AbortController().signal, () => {}, enabled)
    const article = await bundle.tools.read_help_article!.execute!({ slug: 'prmpt1-test-guide' }, {} as any) as Record<string, unknown>
    assert.equal(article.error, undefined)
    assert.equal(article.article_id, articleId)
    assert.equal(article.url, 'http://localhost:3000/help/prmpt1-test-guide')
    assert.equal(article.customer_visible, true)
    const search = await bundle.tools.search_help_articles!.execute!({ queries: ['test guide', 'test content'] }, {} as any) as { articles: { article_id: string; matched_queries: string[] }[] }
    assert.deepEqual(search.articles.map(article => article.article_id), [articleId])
    assert.deepEqual(search.articles[0]!.matched_queries, ['test guide', 'test content'])
    await pool.query('UPDATE help_collection SET visible=false WHERE id=$1', [collectionId])
    assert.equal((await loadAgentPromptContext(pool, actor)).knowledgeEnabled, true)
    const hidden = await bundle.tools.read_help_article!.execute!({ article_id: articleId }, {} as any) as Record<string, unknown>
    assert.equal(hidden.error, undefined)
    assert.equal(hidden.customer_visible, false)
    assert.equal(hidden.url, null)
    await pool.query('UPDATE help_article SET ai_enabled=false WHERE id=$1', [articleId])
    await pool.query('UPDATE help_collection SET visible=true WHERE id=$1', [collectionId])
    await pool.query('UPDATE organization SET metadata=$2,name=$3 WHERE id=$1', [orgId, JSON.stringify({ portalModules: { helpCenter: false }, guest: { allowPost: false, allowVote: true, allowComment: true } }), 'Renamed Product'])
    await pool.query("UPDATE organization_widget SET support_email=NULL,custom_rules='[]'::jsonb WHERE org_id=$1", [orgId])
    const disabled = await loadAgentPromptContext(pool, actor)
    assert.equal(disabled.productName, 'Renamed Product')
    assert.equal(disabled.knowledgeEnabled, false)
    assert.deepEqual(disabled.articles, [])
    assert.doesNotMatch(renderAgentSystemPrompt(disabled), /## Article Catalog/)
    assert.deepEqual(disabled.supportRules, [])
    assert.equal(disabled.supportEmail, null)
    assert.equal(disabled.feedback.create, false)
    assert.equal(disabled.feedback.vote, true)
    assert.equal(disabled.feedback.commentScope, 'all')
  } finally {
    await pool.query('DELETE FROM help_article WHERE org_id=$1', [orgId])
    await pool.query('DELETE FROM help_collection WHERE org_id=$1', [orgId])
    await pool.query('DELETE FROM board WHERE org_id=$1', [orgId])
    await pool.query('DELETE FROM organization WHERE id=$1', [orgId])
  }
})

test('customer input cannot forge Agent result cards; image has only a storage reference', () => {
  assert.equal(customerContent.safeParse({ parts: [{ type: 'feedback_created', feedback_id: uuidv7() }] }).success, false)
  assert.equal(customerContent.safeParse({ parts: [{ type: 'image', storage_key: 'uploads/example/image.png' }] }).success, true)
  assert.equal(customerContent.safeParse({ parts: [{ type: 'image', storage_key: 'uploads/example/image.png', url: 'https://example.com/image.png' }] }).success, false)
  assert.equal(contentSchema.safeParse({ parts: [{ type: 'article_reference', articles: [] }] }).success, false)
})

test('failed and untagged model outputs are excluded while customer history remains', () => {
  const processor = historyProcessor('new-run', new Set(['customer-1', 'customer-2']), new Set(['successful-run']))
  const message = (id: string, metadata: object) => ({ id, role: 'assistant', content: { format: 2, parts: [{ type: 'text', text: id }], metadata } })
  const messages = [message('customer', { feedlogItemId: 'customer-1' }), message('success', { feedlogRunId: 'successful-run' }), message('failed', { feedlogRunId: 'failed-run' }), message('unknown', {}), message('current', { feedlogItemId: 'customer-2' })]
  const selected = processor.processInput({ messages } as any)
  assert.deepEqual(selected.map(m => m.id), ['customer', 'success', 'current'])
  const tagged = processor.processOutputResult({ messages: [messages[1], message('new', {})] } as any)
  assert.equal(tagged[0]!.content.metadata?.feedlogRunId, 'successful-run')
  assert.equal(tagged[1]!.content.metadata?.feedlogRunId, 'new-run')
})

test('stream collection keeps finish out of the client stream until business commit', async () => {
  const seen: string[] = []
  const input = new ReadableStream({ start(c) {
    for (const chunk of [{ type: 'start', messageId: 'sdk-id' }, { type: 'text-start', id: 'text-1' }, { type: 'text-delta', id: 'text-1', delta: 'Saved.' }, { type: 'text-end', id: 'text-1' }, { type: 'finish', finishReason: 'stop' }]) c.enqueue(chunk)
    c.close()
  } })
  const reply = await collectConversationReply(input, 'business-id', chunk => seen.push(chunk.type))
  assert.equal(reply.message.id, 'business-id')
  assert.equal(reply.finish.type, 'finish')
  assert.equal(seen.includes('finish'), false)
  await assert.rejects(() => collectConversationReply(new ReadableStream({ start(c) { c.enqueue({ type: 'start' }); c.close() } }), 'failed', () => {}), /did not complete/)
})

test('feedback updates preserve omitted fields, return saved content and enforce edit ownership', async () => {
  const orgId = `agent-update-test-${uuidv7()}`
  const otherOrgId = `agent-update-test-${uuidv7()}`
  const userId = `agent-update-user-${uuidv7()}`
  const otherUserId = `agent-update-user-${uuidv7()}`
  const conversationId = uuidv7()
  const otherConversationId = uuidv7()
  const postIds = [uuidv7(), uuidv7(), uuidv7(), uuidv7()]
  const [postId, historicalPostId, otherAuthorPostId, otherOrgPostId] = postIds
  const originalContent = 'The report export fails.\n\nThe preview works correctly.\n\n    preserve indentation\n'
  const actor = { orgId, customerId: userId, retentionDays: 30, session: { user: { id: userId } } } as Actor
  const { memory } = runtime
  try {
    for (const id of [orgId, otherOrgId]) await pool.query('INSERT INTO organization (id,name,slug) VALUES ($1,$1,$1)', [id])
    for (const id of [userId, otherUserId]) await pool.query('INSERT INTO "user" (id,name,email) VALUES ($1,$1,$2)', [id, `${id}@example.invalid`])
    for (const [index, id] of postIds.entries()) {
      const postOrg = index === 3 ? otherOrgId : orgId
      await pool.query('INSERT INTO post (id,org_id,author_id,slug,title,content) VALUES ($1,$2,$3,$4,$5,$6)', [id, postOrg, index === 2 ? otherUserId : userId, `report-${id}`, 'Report export fails', originalContent])
      await pool.query('INSERT INTO post_search (post_id,org_id,search_text) VALUES ($1,$2,$3)', [id, postOrg, 'Report export fails'])
    }
    const triggerId = uuidv7()
    const { run } = await startRun(runtime, conversationId, actor, { action: 'send', idempotency_key: triggerId, message: { id: triggerId, content: { parts: [{ type: 'text', text: 'Correct the report title.' }] }, context: null } })
    await memory.createThread({ threadId: conversationId, resourceId: `${orgId}:${conversationId}`, title: 'Update test', metadata: {
      effects: Object.fromEntries([postId, otherAuthorPostId, otherOrgPostId].map(id => [id, { id, kind: 'feedback', triggerId }])),
    } })
    const context: AgentPromptContext = { productName: 'Example Product', boards: [], supportRules: [], knowledgeEnabled: false, articles: [], feedback: { create: false, vote: false, subscribe: false, commentScope: 'own' } }
    const bundle = () => feedlogTools(event, actor, conversationId, run.id, triggerId, new AbortController().signal, () => {}, context)
    const execute = async (input: object, tools = bundle()) => ({
      tools, result: await tools.tools.update_feedback!.execute!(input, {} as any) as any,
    })
    const read = async (id: string, tools = bundle()) => await tools.tools.get_feedback!.execute!({ feedback_id: id }, {} as any) as any
    const matches = await bundle().tools.search_feedback!.execute!({ query: 'report' }, {} as any) as any[]
    const portalMatches = await searchSimilarByText('report', { orgId, userId, limit: 8 })
    assert.deepEqual(matches.map(row => row.feedback_id), portalMatches.map(row => row.id))
    assert.deepEqual(new Map(matches.map(row => [row.feedback_id, row.editable])), new Map([[postId, true], [historicalPostId, false], [otherAuthorPostId, false]]))
    assert.ok(matches.every(row => !('author_id' in row)))
    for (const hit of matches) {
      const details = await read(hit.feedback_id)
      assert.equal(details.feedback.editable, hit.editable)
      assert.equal(details.feedback.content, originalContent)
    }
    assert.match((await read(otherOrgPostId!)).error, /not found/)
    const schema = bundle().tools.update_feedback!.inputSchema as any
    for (const input of [{ feedback_id: postId }, { feedback_id: postId, title: '  ' }, { feedback_id: postId, content: '\n ' }, { feedback_id: postId, content: null }, { feedback_id: postId, title: 'Corrected', unexpected: true }]) {
      assert.equal(schema.safeParse(input).success, false)
    }
    const titled = await execute({ feedback_id: postId, title: 'CSV report export fails' })
    assert.equal(titled.result.changed, true)
    assert.equal(titled.result.feedback.content, originalContent)
    assert.equal(titled.result.feedback.title, 'CSV report export fails')
    assert.equal(titled.result.feedback.url, `http://localhost:3000/p/report-${postId}`)
    assert.equal((await titled.tools.resultParts())[0]?.type, 'feedback_updated')
    const currentTitle = 'CSV export fails on download'
    await pool.query('UPDATE post SET title=$2 WHERE id=$1', [postId, currentTitle])
    const revisedContent = 'CSV report export fails on download.\n\nThe preview works correctly.\n\n    preserve indentation\n'
    const revised = await execute({ feedback_id: postId, content: revisedContent })
    assert.equal(revised.result.changed, true)
    assert.equal(revised.result.feedback.title, currentTitle)
    assert.equal(revised.result.feedback.content, revisedContent)
    assert.equal(revised.result.feedback.editable, true)
    assert.deepEqual((await read(postId!)).feedback, revised.result.feedback)
    const { rows: [saved] } = await pool.query('SELECT p.*,s.search_text FROM post p JOIN post_search s ON s.post_id=p.id WHERE p.id=$1', [postId])
    assert.equal(saved.content, revisedContent)
    assert.equal(saved.title, currentTitle)
    assert.match(saved.excerpt, /preview works correctly/)
    assert.match(saved.search_text, /CSV export fails on download/)
    assert.match(saved.search_text, /preview works correctly/)
    assert.match(saved.content_hash, /^[a-f0-9]{64}$/)
    const unchanged = await execute({ feedback_id: postId, title: currentTitle, content: revisedContent })
    assert.equal(unchanged.result.changed, false)
    assert.equal(embeddingWrites.filter(id => id === postId).length, 2)
    assert.deepEqual(unchanged.result.feedback, revised.result.feedback)
    assert.deepEqual(await unchanged.tools.resultParts(), [])
    const { rows: [afterNoChange] } = await pool.query('SELECT updated_at,content_hash FROM post WHERE id=$1', [postId])
    assert.equal(afterNoChange.updated_at.getTime(), saved.updated_at.getTime())
    assert.equal(afterNoChange.content_hash, saved.content_hash)
    assert.match((await execute({ feedback_id: historicalPostId, title: 'Forbidden' })).result.error, /Only content created by this Agent/)
    assert.match((await execute({ feedback_id: otherAuthorPostId, title: 'Forbidden' })).result.error, /no longer editable/)
    assert.match((await execute({ feedback_id: otherOrgPostId, title: 'Forbidden' })).result.error, /not found/)
    const otherTriggerId = uuidv7()
    const { run: otherRun } = await startRun(runtime, otherConversationId, actor, { action: 'send', idempotency_key: otherTriggerId, message: { id: otherTriggerId, content: { parts: [{ type: 'text', text: 'Another conversation' }] }, context: null } })
    const otherBundle = feedlogTools(event, actor, otherConversationId, otherRun.id, otherTriggerId, new AbortController().signal, () => {}, context)
    assert.equal((await read(postId!, otherBundle)).feedback.editable, false)
    assert.match((await execute({ feedback_id: postId, title: 'Forbidden' }, otherBundle)).result.error, /Only content created by this Agent/)
    await pool.query('UPDATE post SET merged_to=$2 WHERE id=$1', [historicalPostId, postId])
    assert.match((await read(historicalPostId!)).error, /already merged/)
    const unmerged = await bundle().tools.search_feedback!.execute!({ query: 'report' }, {} as any) as any[]
    assert.equal(unmerged.some(row => row.feedback_id === historicalPostId), false)
    await failRun(runtime, run.id, 'Test finished')
    assert.match((await execute({ feedback_id: postId, title: 'Forbidden' })).result.error, /no longer active/)
    const { rows: untouched } = await pool.query('SELECT title,content FROM post WHERE id=ANY($1::uuid[])', [postIds.slice(1)])
    assert.ok(untouched.every(row => row.title === 'Report export fails' && row.content === originalContent))
  } finally {
    await memory.deleteThread(conversationId)
    await pool.query('DELETE FROM post_search WHERE post_id=ANY($1::uuid[])', [postIds])
    await pool.query('DELETE FROM post WHERE id=ANY($1::uuid[])', [postIds])
    await pool.query('DELETE FROM agent_run WHERE conversation_id=ANY($1::uuid[])', [[conversationId, otherConversationId]])
    await pool.query('DELETE FROM conversation_item WHERE conversation_id=ANY($1::uuid[])', [[conversationId, otherConversationId]])
    await pool.query('DELETE FROM conversation WHERE id=ANY($1::uuid[])', [[conversationId, otherConversationId]])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [[userId, otherUserId]])
    await pool.query('DELETE FROM organization WHERE id=ANY($1::text[])', [[orgId, otherOrgId]])
  }
})

test('feedback creation commits before indexing and remains searchable on retry', async () => {
  const orgId = `agent-create-test-${uuidv7()}`
  const userId = `agent-create-user-${uuidv7()}`
  const conversationId = uuidv7()
  const boardId = uuidv7()
  const triggerId = uuidv7()
  const { memory } = runtime
  const actor = { orgId, customerId: userId, retentionDays: 30, session: { user: { id: userId } } } as Actor
  try {
    await pool.query('INSERT INTO organization (id,name,slug) VALUES ($1,$1,$1)', [orgId])
    await pool.query('INSERT INTO "user" (id,name,email) VALUES ($1,$1,$2)', [userId, `${userId}@example.invalid`])
    await pool.query('INSERT INTO board (id,org_id,name) VALUES ($1,$2,$3)', [boardId, orgId, 'Requests'])
    const { run } = await startRun(runtime, conversationId, actor, { action: 'send', idempotency_key: triggerId, message: { id: triggerId, content: { parts: [{ type: 'text', text: 'Add dark mode support' }] }, context: null } })
    await memory.createThread({ threadId: conversationId, resourceId: `${orgId}:${conversationId}`, title: 'Create test' })
    const context: AgentPromptContext = { productName: 'Example Product', boards: [{ id: boardId, name: 'Requests', description: null }], supportRules: [], knowledgeEnabled: false, articles: [], feedback: { create: true, vote: false, subscribe: true, commentScope: 'all' } }
    const bundle = feedlogTools(event, actor, conversationId, run.id, triggerId, new AbortController().signal, () => {}, context)
    const input = { board_id: boardId, title: 'Add dark mode support', content: 'I would like a dark theme.' }
    const created = await bundle.tools.create_feedback!.execute!(input, {} as any) as any
    assert.equal(created.type, 'feedback_created')
    assert.ok(embeddingWrites.includes(created.feedback_id))
    const retried = await bundle.tools.create_feedback!.execute!(input, {} as any) as any
    assert.equal(retried.feedback_id, created.feedback_id)
    assert.equal((await pool.query('SELECT id FROM post WHERE org_id=$1', [orgId])).rowCount, 1)
    const matches = await bundle.tools.search_feedback!.execute!({ query: 'dark mode night mode theme support' }, {} as any) as any[]
    assert.deepEqual(matches.map(hit => hit.feedback_id), [created.feedback_id])
    assert.equal(matches[0].editable, true)
  } finally {
    await memory.deleteThread(conversationId)
    await pool.query('DELETE FROM post WHERE org_id=$1', [orgId])
    await pool.query('DELETE FROM board WHERE id=$1', [boardId])
    await pool.query('DELETE FROM agent_run WHERE conversation_id=$1', [conversationId])
    await pool.query('DELETE FROM conversation_item WHERE conversation_id=$1', [conversationId])
    await pool.query('DELETE FROM conversation WHERE id=$1', [conversationId])
    await pool.query('DELETE FROM "user" WHERE id=$1', [userId])
    await pool.query('DELETE FROM organization WHERE id=$1', [orgId])
  }
})


test('history keeps text and replaces every legacy image with an explicit reinspection reference', () => {
  const processor = historyProcessor('run', new Set(['old', 'new']), new Set())
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2kAAAAASUVORK5CYII='
  const messages = [
    { id: 'old', role: 'user', content: { format: 2, metadata: { feedlogItemId: 'old' }, parts: [
      { type: 'text', text: 'Earlier question' }, { type: 'file', mimeType: 'image/svg+xml', data: 'data:image/svg+xml;base64,PHN2Zy8+' },
    ] } },
    { id: 'new', role: 'user', content: { format: 2, metadata: { feedlogItemId: 'new' }, parts: [
      { type: 'file', mimeType: 'image/png', data: `data:image/png;base64,${png}` },
    ] } },
  ]
  const output = processor.processInput({ messages } as any)
  assert.equal(output[0]!.content.parts[0]!.type, 'text')
  assert.equal(output[0]!.content.parts[1]!.type, 'text')
  assert.equal(output[1]!.content.parts[0]!.type, 'text')
  assert.equal(messages[0]!.content.parts[1]!.type, 'file', 'saved history is not mutated')
})

test('database memory projection excludes legacy pixels before returning a bounded context', async () => {
  const { BoundedMemoryPG } = await import('../server/lib/agent/memory-store')
  const store = new BoundedMemoryPG(pool)
  const thread = uuidv7(), message = uuidv7(), resource = `memory-test:${thread}`
  await runtime.memory.createThread({ threadId: thread, resourceId: resource, title: 'Memory budget test' })
  try {
    await pool.query(`INSERT INTO mastra_messages(id,thread_id,"resourceId",role,type,"createdAt",content)
      VALUES($1,$2,$3,'user','v2',now(),jsonb_build_object('format',2,'metadata',jsonb_build_object('feedlogItemId','legacy'),
      'parts',jsonb_build_array(jsonb_build_object('type','text','text','Original question'),
      jsonb_build_object('type','file','mimeType','image/png','data','data:image/png;base64,'||repeat('A',24*1024*1024))))::text)`, [message, thread, resource])
    const result = await store.listMessages({ threadId: thread, resourceId: resource, perPage: false })
    assert.equal(result.messages.length, 1)
    assert.ok(JSON.stringify(result).length < 2000)
    assert.match(JSON.stringify(result), /Original question/)
    assert.match(JSON.stringify(result), /read_conversation_images/)
    assert.equal((await store.listMessages({ threadId: thread, resourceId: 'another-tenant' })).messages.length, 0)
    assert.ok(JSON.stringify(await store.listMessagesById({ messageIds: [message] })).length < 2000)
    const { rows: [original] } = await pool.query('SELECT octet_length(content) AS bytes FROM mastra_messages WHERE id=$1', [message])
    assert.ok(original.bytes > 24 * 1024 * 1024, 'projection does not destructively rewrite the archive')
  } finally { await runtime.memory.deleteThread(thread) }
})
