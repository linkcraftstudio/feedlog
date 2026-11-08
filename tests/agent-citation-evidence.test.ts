import assert from 'node:assert/strict'
import { test } from 'node:test'
import { keepVerifiedHelpReferences, removeUnverifiedAnswerLinks, verifyHelpCitations } from '../server/lib/agent/citation-evidence'
import type { Part } from '../shared/agent/content'

const candidates = [
  { id: 'answer', title: 'Operation', content: 'A failed export can be retried within 72 hours. The original filters are reused.' },
  { id: 'navigation', title: 'History', content: 'Open [Dashboard](https://example.invalid/dashboard) to find previous export results and available downloads.' },
]

test('citation verifier keeps exact evidence for the requested answer, not incidental navigation', async () => {
  const before = { ...process.env }, fetchBefore = globalThis.fetch
  Object.assign(process.env, { OPENAI_API_KEY: 'test', OPENAI_TEXT_MODEL: 'test', OPENAI_BASE_URL: 'https://example.invalid/v1' })
  try {
    globalThis.fetch = async () => Response.json({
      choices: [{ message: { content: JSON.stringify({ matches: [{ id: 'answer', quotes: ['A failed export can be retried within 72 hours. The original filters are reused.'] }] }) } }],
    })
    const verdict = await verifyHelpCitations('两天半后还能按原筛选条件重试吗？',
      '可以，失败后 72 小时内可重试，并沿用原筛选条件。你可以打开 Dashboard。', candidates)
    assert.equal(verdict.status, 'verified')
    const parts: Part[] = [
      { type: 'text', text: '可以，失败后 72 小时内可重试。' },
      { type: 'article_reference', articles: candidates.map(candidate => ({ article_id: candidate.id, title: candidate.title, slug: candidate.id })) },
    ]
    const kept = keepVerifiedHelpReferences(parts, new Set(verdict.matches.map(match => match.id)))
    assert.deepEqual(kept[1], { type: 'article_reference', articles: [{ article_id: 'answer', title: 'Operation', slug: 'answer' }] })
    assert.deepEqual(keepVerifiedHelpReferences(parts, new Set()), [parts[0]])
    assert.equal(removeUnverifiedAnswerLinks('Go to [Dashboard](https://example.invalid/dashboard) after retrying.', candidates, new Set(['answer'])),
      'Go to Dashboard after retrying.')
    assert.equal(removeUnverifiedAnswerLinks('Go to [Dashboard](https://example.invalid/dashboard) after retrying.', [candidates[0]!], new Set(['answer'])),
      'Go to Dashboard after retrying.', 'unverified links are removed even when the Agent did not request a citation for their source')
    assert.equal(removeUnverifiedAnswerLinks('Go to [Dashboard](https://example.invalid/dashboard).', candidates, new Set(['navigation'])),
      'Go to [Dashboard](https://example.invalid/dashboard).')
    globalThis.fetch = async () => new Response('unavailable', { status: 503 })
    assert.deepEqual((await verifyHelpCitations('question', 'answer', candidates)).matches, [])
  } finally {
    globalThis.fetch = fetchBefore
    for (const key of ['OPENAI_API_KEY', 'OPENAI_TEXT_MODEL', 'OPENAI_BASE_URL']) {
      if (before[key] === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = before[key]
    }
  }
})
