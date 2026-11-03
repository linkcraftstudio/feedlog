import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { Pool } from 'pg'
import { createError } from 'h3'
import { uuidv7 } from 'uuidv7'
import { generateExcerpt, stripMarkdown } from '../shared/utils/markdown'
import { computeContentHash } from '../server/utils/hash'

// Outside Nuxt: resolve the `#layers/feedlog/` alias, and packages Nuxt brings
// in transitively (consola for server/db) from pnpm's hoisted store, in this
// checkout or in the app embedding it as a layer.
register(`data:text/javascript,${encodeURIComponent(`
  import { existsSync } from 'node:fs'
  const root = ${JSON.stringify(new URL('../', import.meta.url).href)}
  const stores = ['node_modules/.pnpm/', '../../node_modules/.pnpm/'].map(path => new URL(path, root)).filter(url => existsSync(url))
  export async function resolve(specifier, context, next) {
    if (specifier.startsWith('#layers/feedlog/')) {
      const base = new URL(specifier.slice('#layers/feedlog/'.length), root)
      const file = [base.href + '.ts', base.href + '/index.ts', base.href].find(candidate => existsSync(new URL(candidate)))
      return next(file ?? specifier, context)
    }
    try { return await next(specifier, context) }
    catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND' || /^[./]|^[a-z]+:/.test(specifier)) throw error
      for (const store of stores) {
        try { return await next(specifier, { ...context, parentURL: new URL('resolve.js', store).href }) } catch {}
      }
      throw error
    }
  }
`)}`)

const url = new URL(process.env.DATABASE_URL ?? '')
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname), 'Integration tests require a local database')
delete process.env.OPENAI_API_KEY
delete process.env.HELP_VECTOR_SEARCH

const { db } = await import('../server/db')
const { generateSlug } = await import('../server/utils/slug')
// Nitro auto-imports used by the reused write paths.
Object.assign(globalThis, { useDB: () => db, createError, stripMarkdown, generateExcerpt, computeContentHash, generateSlug })
const { seedOnboarding, clearOnboardingAutoOpen } = await import('../server/lib/onboarding/seed')
const { SAMPLE_CUSTOMERS, sampleCustomerEmail } = await import('../server/lib/onboarding/sample-content')

const pool = new Pool({ connectionString: url.href })
after(async () => {
  await pool.end()
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end()
})

async function fixture() {
  const orgId = `onboarding-test-${uuidv7()}`
  const ownerId = `onboarding-owner-${uuidv7()}`
  await pool.query('INSERT INTO organization (id,name,slug,created_at) VALUES ($1,$2,$1,now())', [orgId, 'Acme Analytics'])
  await pool.query('INSERT INTO "user" (id,name,email) VALUES ($1,$1,$2)', [ownerId, `${ownerId}@example.com`])
  await pool.query("INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ($1,$2,$3,'owner',now())", [uuidv7(), orgId, ownerId])
  for (const [position, name] of ['Feature Requests', 'Bug Report'].entries()) {
    await pool.query('INSERT INTO board (id,org_id,name,position) VALUES ($1,$2,$3,$4)', [uuidv7(), orgId, name, position])
  }
  const cleanup = async () => {
    const { rows } = await pool.query('SELECT id FROM conversation WHERE org_id=$1', [orgId])
    for (const { id } of rows) {
      await pool.query('DELETE FROM scheduled_task WHERE ref_id=$1 OR ref_id IN (SELECT id FROM agent_run WHERE conversation_id=$1)', [id])
      await pool.query("DELETE FROM conversation_item WHERE conversation_id=$1 AND author_type='agent'", [id])
      await pool.query('DELETE FROM agent_run WHERE conversation_id=$1', [id])
      await pool.query('DELETE FROM conversation_item WHERE conversation_id=$1', [id])
    }
    await pool.query("DELETE FROM scheduled_task WHERE kind='help_index' AND ref_id IN (SELECT id FROM help_article WHERE org_id=$1)", [orgId])
    await pool.query('DELETE FROM help_article_chunk WHERE org_id=$1', [orgId])
    for (const table of ['vote', 'comment', 'post_subscription']) await pool.query(`DELETE FROM ${table} WHERE post_id IN (SELECT id FROM post WHERE org_id=$1)`, [orgId])
    for (const table of ['post', 'board', 'help_article', 'help_collection', 'conversation']) await pool.query(`DELETE FROM ${table} WHERE org_id=$1`, [orgId])
    await pool.query('DELETE FROM member WHERE organization_id=$1', [orgId])
    await pool.query('DELETE FROM organization WHERE id=$1', [orgId])
    await pool.query('DELETE FROM "user" WHERE id=$1 OR email=ANY($2)', [ownerId, SAMPLE_CUSTOMERS.map(c => sampleCustomerEmail(c.emailLocal, orgId))])
  }
  return { orgId, ownerId, cleanup }
}

const metadataOf = async (orgId: string) => JSON.parse((await pool.query('SELECT metadata FROM organization WHERE id=$1', [orgId])).rows[0].metadata)

test('seeds sample content, conversations and flags that satisfy every constraint, once', async () => {
  const { orgId, ownerId, cleanup } = await fixture()
  try {
    assert.deepEqual(await seedOnboarding({ orgId, ownerId }), { content: 'seeded', conversations: 'seeded' })

    const metadata = await metadataOf(orgId)
    assert.deepEqual(metadata.guest, { allowPost: true, allowVote: true, allowComment: true })
    assert.equal(metadata.portalModules.helpCenter, true)
    assert.equal(metadata.onboarding.autoOpenFor, ownerId)
    assert.ok(!Number.isNaN(Date.parse(metadata.onboarding.sampleSeededAt)))

    const { rows: customers } = await pool.query('SELECT id,name,email,is_anonymous FROM "user" WHERE email LIKE $1', [`%-${orgId.slice(0, 8)}@sample.invalid`])
    assert.equal(customers.length, 4)
    assert.ok(customers.every(c => c.is_anonymous === false))
    const { rowCount: accounts } = await pool.query('SELECT 1 FROM account WHERE user_id=ANY($1)', [customers.map(c => c.id)])
    assert.equal(accounts, 0)
    const customerId = (name: string) => customers.find(c => c.name === name)!.id

    const { rows: articles } = await pool.query("SELECT a.id,a.title,a.status,a.content FROM help_article a WHERE a.org_id=$1 ORDER BY a.title", [orgId])
    assert.equal(articles.length, 4)
    assert.ok(articles.every(a => a.status === 'published' && a.title.startsWith('[Sample] ')))
    assert.ok(articles.some(a => a.content.includes('Acme Analytics')) && articles.every(a => !a.content.includes('{{product}}')))
    const { rowCount: indexTasks } = await pool.query("SELECT 1 FROM scheduled_task WHERE kind='help_index' AND status='pending' AND ref_id=ANY($1)", [articles.map(a => a.id)])
    assert.equal(indexTasks, 4, 'Publishing queues the normal help index job')

    const { rows: posts } = await pool.query(`SELECT p.*,b.name AS board_name,(SELECT count(*)::int FROM vote v WHERE v.post_id=p.id) AS votes
      FROM post p LEFT JOIN board b ON b.id=p.board_id WHERE p.org_id=$1 ORDER BY p.created_at`, [orgId])
    assert.deepEqual(posts.map(p => [p.title, p.board_name, p.status, p.vote_count, p.votes]), [
      ['[Sample] Comment notification emails arrive late', 'Bug Report', 'planned', 2, 2],
      ['[Sample] Export reports to CSV', 'Feature Requests', 'open', 0, 0],
    ])
    const [lateEmails, csv] = posts
    assert.equal(lateEmails.source_conversation_id, null)
    const { rowCount: searchRows } = await pool.query('SELECT 1 FROM post_search WHERE post_id=ANY($1)', [posts.map(p => p.id)])
    assert.equal(searchRows, 2)

    const { rows: conversations } = await pool.query(`SELECT c.*,(SELECT max(seq) FROM conversation_item i WHERE i.conversation_id=c.id) AS max_seq,
      (SELECT count(*)::int FROM conversation_item i WHERE i.conversation_id=c.id) AS items FROM conversation c WHERE c.org_id=$1`, [orgId])
    assert.equal(conversations.length, 4)
    const byCustomer = (name: string) => conversations.find(c => c.user_id === customerId(name))!
    for (const c of conversations) {
      assert.equal(Number(c.last_seq), Number(c.max_seq))
      assert.equal(Number(c.last_seq), c.items)
      assert.equal(c.state_due_at, null)
      const { rows: items } = await pool.query('SELECT seq,created_at FROM conversation_item WHERE conversation_id=$1 ORDER BY seq', [c.id])
      for (let i = 1; i < items.length; i++) assert.ok(items[i].created_at >= items[i - 1].created_at, 'Backdated times follow seq order')
      assert.ok(c.last_message_at < new Date(), 'last_message_at is backdated')
    }
    assert.deepEqual(['Emma Chen', 'Daniel Park', 'Nora Schmidt', 'Sofia Martinez'].map(name => [byCustomer(name).status, byCustomer(name).priority]),
      [['open', 0], ['ai_handling', 0], ['ai_handling', 0], ['closed', 0]])
    assert.equal(csv.source_conversation_id, byCustomer('Daniel Park').id)
    assert.equal(byCustomer('Emma Chen').title, '[Sample] How long does a refund take to show up on my card?')
    assert.equal(byCustomer('Emma Chen').preview_text, '[Sample] Both charges are on the same day and for the same amount. The invoice numbers end in 1042 and 1043.')

    const emma = byCustomer('Emma Chen').id
    const { rows: [handoffItem] } = await pool.query("SELECT id,content FROM conversation_item WHERE conversation_id=$1 AND author_type='system'", [emma])
    const runId = handoffItem.id.replace('handoff:', '')
    const { rows: [handoffRun] } = await pool.query('SELECT status FROM agent_run WHERE id=$1', [runId])
    assert.equal(handoffRun.status, 'cancelled')
    assert.equal(handoffItem.content.parts[0].rule.id, 'builtin-billing')
    const { rows: [lastEmma] } = await pool.query('SELECT author_type FROM conversation_item WHERE conversation_id=$1 ORDER BY seq DESC LIMIT 1', [emma])
    assert.equal(lastEmma.author_type, 'customer')

    const { rows: agentItems } = await pool.query(`SELECT i.content,r.status FROM conversation_item i JOIN agent_run r ON r.id=i.agent_run_id
      JOIN conversation c ON c.id=i.conversation_id WHERE c.org_id=$1 AND i.author_type='agent'`, [orgId])
    assert.equal(agentItems.length, 6)
    assert.ok(agentItems.every(i => i.status === 'completed'))
    const cards = agentItems.flatMap(i => i.content.parts.filter((p: { type: string }) => p.type !== 'text'))
    assert.deepEqual(cards.map((p: { type: string }) => p.type).sort(), ['article_reference', 'article_reference', 'article_reference', 'feedback_created', 'feedback_upvoted'])
    const created = cards.find((p: { type: string }) => p.type === 'feedback_created')
    assert.equal(created.feedback_id, csv.id)
    assert.equal(created.title, '[Sample] Export reports to CSV')
    const upvoted = cards.find((p: { type: string }) => p.type === 'feedback_upvoted')
    assert.deepEqual([upvoted.feedback_id, upvoted.vote_count, upvoted.has_voted], [lateEmails.id, 2, true])
    const reference = cards.find((p: { type: string; articles?: { title: string }[] }) => p.articles?.[0]?.title === '[Sample] Plans, billing and refunds')
    assert.match(reference.articles[0].slug, /^[A-Za-z0-9]{6}-sample-plans-billing-and-refunds$/)

    const { rowCount: tasks } = await pool.query(`SELECT 1 FROM scheduled_task WHERE kind IN ('inbox_due','agent_deadline','inbox_email','inbox_handoff_email')
      AND (ref_id IN (SELECT id FROM conversation WHERE org_id=$1) OR ref_id IN (SELECT r.id FROM agent_run r JOIN conversation c ON c.id=r.conversation_id WHERE c.org_id=$1))`, [orgId])
    assert.equal(tasks, 0, 'The seed leaves no inbox timers or emails behind')

    assert.deepEqual(await seedOnboarding({ orgId, ownerId }), { content: 'skipped', conversations: 'skipped' })
    const { rows: [counts] } = await pool.query(`SELECT (SELECT count(*)::int FROM conversation WHERE org_id=$1) AS c,
      (SELECT count(*)::int FROM post WHERE org_id=$1) AS p, (SELECT count(*)::int FROM help_article WHERE org_id=$1) AS a`, [orgId])
    assert.deepEqual(counts, { c: 4, p: 2, a: 4 })
  } finally {
    await cleanup()
  }
})

test('the auto-open marker clears only for its own user and keeps the seed marker', async () => {
  const { orgId, ownerId, cleanup } = await fixture()
  try {
    await seedOnboarding({ orgId, ownerId })
    assert.equal(await clearOnboardingAutoOpen(orgId, 'someone-else'), false)
    assert.equal((await metadataOf(orgId)).onboarding.autoOpenFor, ownerId)
    assert.equal(await clearOnboardingAutoOpen(orgId, ownerId), true)
    const { onboarding } = await metadataOf(orgId)
    assert.equal(onboarding.autoOpenFor, undefined)
    assert.ok(onboarding.sampleSeededAt)
    assert.equal(await clearOnboardingAutoOpen(orgId, ownerId), false)
  } finally {
    await cleanup()
  }
})

test('a missing organization fails quietly instead of throwing to the caller', async () => {
  const errors = console.error
  console.error = () => {}
  try {
    assert.deepEqual(await seedOnboarding({ orgId: `missing-${uuidv7()}`, ownerId: 'nobody' }), { content: 'failed', conversations: 'failed' })
  } finally {
    console.error = errors
  }
})

test('sendEmail never hands a reserved .invalid recipient to the provider', async () => {
  const { registerEmailProvider, sendEmail, isUndeliverableEmail } = await import('../server/utils/email')
  const sent: string[] = []
  const previous = process.env.EMAIL_PROVIDER
  process.env.EMAIL_PROVIDER = 'onboarding-test'
  registerEmailProvider({ name: 'onboarding-test', send: async ({ to }) => { sent.push(to) } })
  try {
    for (const to of ['emma.chen-abcd1234@sample.invalid', 'anon-1@feedlog.invalid', 'X@Example.INVALID ']) {
      assert.equal(isUndeliverableEmail(to), true)
      await sendEmail({ to, subject: 'Hello', html: '<p>Hello</p>' })
    }
    await sendEmail({ to: 'owner@example.com', subject: 'Hello', html: '<p>Hello</p>' })
    assert.deepEqual(sent, ['owner@example.com'])
    assert.equal(isUndeliverableEmail('someone@invalid.example.com'), false)
  } finally {
    if (previous === undefined) delete process.env.EMAIL_PROVIDER
    else process.env.EMAIL_PROVIDER = previous
  }
})
