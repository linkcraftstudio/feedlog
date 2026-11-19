import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { searchKnowledgeBase } from '../server/lib/agent/knowledge-search'
import { searchHelpArticles } from '../server/lib/agent/help-search'
import { HelpEmbeddingError } from '../server/lib/help-search/embedding'

const article = (id: string) => ({ article_id: id, title: 'Widget guide', description: null, content: 'The widget supports projects.', slug: 'abc-guide', published: true })
const web = { id: 'web', title: 'Widget guide', url: 'https://example.com/widget', content: 'The widget supports projects.', websiteId: 'site', heading: 'Widget', language: 'en' }

test('query ranks survive interleave and dedup before cross-source reciprocal rank fusion', async () => {
  const saved = process.env.HELP_VECTOR_SEARCH; process.env.HELP_VECTOR_SEARCH = 'false'
  const groups: Record<string, string[]> = { alpha: ['z-A', 'b-B', 'a-C'], beta: ['a-C', 'd-D', 'z-A'] }
  const pool = { query: async (sql: string, args: unknown[]) => {
    if (sql.includes('FROM organization')) return { rows: [{ metadata: null }] }
    if (sql.includes('SELECT a.id AS article_id')) return { rows: groups[String(args[1])]!.map(article) }
    return { rows: [] }
  } } as unknown as Pool
  try {
    const help = await searchHelpArticles(pool, 'org', { queries: ['alpha', 'beta'] }, 'https://example.com')
    assert.deepEqual(help.articles.map(row => row.article_id), ['z-A', 'a-C', 'b-B', 'd-D'])
    for (const query of ['alpha', 'beta']) assert.deepEqual(help.articles.filter(row => query in row.query_ranks).sort((a, b) => a.query_ranks[query]! - b.query_ranks[query]!).map(row => row.article_id), groups[query])
    const merged = await searchKnowledgeBase(pool, 'org', { queries: ['alpha', 'beta'] }, 'https://example.com')
    assert.equal(merged.results[0]!.id, 'a-C', 'equal original per-query scores use the deterministic ID tie-break, not the lossy interleaved order')
  } finally { if (saved === undefined) delete process.env.HELP_VECTOR_SEARCH; else process.env.HELP_VECTOR_SEARCH = saved }
})

test('embedding outage retains lexical results, shares the failed request and reports partial search', async () => {
  const saved = process.env.HELP_VECTOR_SEARCH; process.env.HELP_VECTOR_SEARCH = 'true'
  let requests = 0
  const pool = { query: async (sql: string) => {
    if (sql.includes('FROM organization')) return { rows: [{ metadata: null }] }
    if (sql.includes('SELECT a.id AS article_id')) return { rows: [article('help')] }
    if (sql.startsWith('SELECT 1')) return { rows: [{}] }
    if (sql.includes('ai_training_web_page')) return { rows: [web] }
    return { rows: [] }
  } } as unknown as Pool
  try {
    const result = await searchKnowledgeBase(pool, 'org', { queries: ['widget'] }, 'https://example.com', async () => { requests++; throw new HelpEmbeddingError('provider_unavailable', true) })
    assert.deepEqual(new Set(result.results.map(row => row.sourceType)), new Set(['help_article', 'web_page']))
    assert.equal(result.partial, true)
    assert.equal(requests, 1)
    assert.equal(result.error, undefined)
    assert.ok(result.warnings.some(warning => warning.sourceType === 'help_article' && warning.stage === 'semantic'))
    assert.ok(result.warnings.some(warning => warning.sourceType === 'web_page' && warning.stage === 'semantic'))
  } finally { if (saved === undefined) delete process.env.HELP_VECTOR_SEARCH; else process.env.HELP_VECTOR_SEARCH = saved }
})

test('provider and per-query failures preserve independent evidence; total outage is explicit and abort is never swallowed', async () => {
  const saved = process.env.HELP_VECTOR_SEARCH; process.env.HELP_VECTOR_SEARCH = 'false'
  let failed: 'help' | 'web' | 'all' | 'query' = 'help'
  const pool = { query: async (sql: string, args: unknown[]) => {
    if (sql.includes('FROM organization')) {
      if (failed === 'help' || failed === 'all') throw new Error('synthetic failure')
      return { rows: [{ metadata: null }] }
    }
    if (sql.includes('SELECT a.id AS article_id')) {
      if (failed === 'query' && args[1] === 'bad') throw new Error('query failed')
      return { rows: [article('help')] }
    }
    if (sql.includes('ai_training_web_page')) {
      if (failed === 'web' || failed === 'all' || failed === 'query' && Array.isArray(args[1]) && args[1].includes('bad')) throw new Error('synthetic failure')
      return { rows: sql.startsWith('SELECT 1') ? [] : [web] }
    }
    return { rows: [] }
  } } as unknown as Pool
  try {
    for (const mode of ['help', 'web'] as const) {
      failed = mode
      const result = await searchKnowledgeBase(pool, 'org', { queries: ['widget'] }, 'https://example.com')
      assert.deepEqual(result.results.map(row => row.sourceType), [mode === 'help' ? 'web_page' : 'help_article'])
      assert.equal(result.partial, true)
      assert.equal(result.error, undefined)
    }
    failed = 'query'
    const partial = await searchKnowledgeBase(pool, 'org', { queries: ['bad', 'widget'] }, 'https://example.com')
    assert.ok(partial.results.length > 0)
    assert.equal(partial.partial, true)
    failed = 'all'
    const unavailable = await searchKnowledgeBase(pool, 'org', { queries: ['widget'] }, 'https://example.com')
    assert.equal(unavailable.error, 'knowledge_search_unavailable')
    assert.deepEqual(unavailable.results, [])
    await assert.rejects(searchKnowledgeBase(pool, 'org', { queries: ['widget'] }, 'https://example.com', undefined, AbortSignal.abort(new Error('Run cancelled'))), /Run cancelled/)
  } finally { if (saved === undefined) delete process.env.HELP_VECTOR_SEARCH; else process.env.HELP_VECTOR_SEARCH = saved }
})
