import assert from 'node:assert/strict'
import { test } from 'node:test'
import { citationSourcesInput, citationReasoningOptions, keepVerifiedHelpReferences, removeUnverifiedAnswerLinks, verifyHelpCitations } from '../server/lib/agent/citation-evidence'
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
      choices: [{ message: { content: JSON.stringify({ matches: [{ id: 'answer', evidenceIds: [0] }] }) } }],
    })
    const verdict = await verifyHelpCitations('两天半后还能按原筛选条件重试吗？',
      '可以，失败后 72 小时内可重试，并沿用原筛选条件。你可以打开 Dashboard。', candidates)
    assert.equal(verdict.status, 'verified')
    assert.deepEqual(verdict.matches, [{ id: 'answer', quotes: [candidates[0]!.content] }])
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
    const unavailable = await verifyHelpCitations('question', 'answer', candidates)
    assert.deepEqual(unavailable.matches, [])
    assert.equal(unavailable.status === 'unavailable' && unavailable.reason, 'provider_error')
  } finally {
    globalThis.fetch = fetchBefore
    for (const key of ['OPENAI_API_KEY', 'OPENAI_TEXT_MODEL', 'OPENAI_BASE_URL']) {
      if (before[key] === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = before[key]
    }
  }
})

test('numbered citation evidence retains exact paragraphs and isolates invalid source selections', async () => {
  const before = { ...process.env }, originalFetch = globalThis.fetch
  Object.assign(process.env, { OPENAI_API_KEY: 'test', OPENAI_TEXT_MODEL: 'test', OPENAI_BASE_URL: 'https://example.invalid/v1' })
  const documents = [
    { id: 'pricing', title: 'Pricing', content: '#### Instagram\n\n≈ 50 Followers / Following\n\n≈ 15 Comments\n\n' + 'This published billing condition remains unchanged. '.repeat(15) },
    { id: 'invalid', title: 'Unrelated', content: 'A different feature has a different retention policy.' },
  ]
  try {
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(init!.body as string)
      assert.equal('reasoning_effort' in request, false, 'other JSON-capable models need not support reasoning parameters')
      const input = JSON.parse(request.messages[1].content)
      const blocks = input.articles[0].blocks as { id: number; text: string }[]
      assert.ok(blocks.every(block => documents[0]!.content.includes(block.text) && block.text.length <= 480))
      assert.equal(blocks.map(block => block.text).find(text => text.includes('15 Comments')), '≈ 15 Comments')
      assert.ok(blocks.at(-1)!.text.endsWith('unchanged.'), 'long paragraphs are included through their end')
      return Response.json({ choices: [{ message: { content: JSON.stringify({ matches: [
        { id: 'pricing', evidenceIds: [0, 2, 999] },
        { id: 'invalid', evidenceIds: [999] },
      ] }) } }] })
    }
    const result = await verifyHelpCitations('Instagram comments credit cost?', 'Approximately 15 comments per credit.', documents)
    assert.equal(result.status, 'verified')
    assert.deepEqual(result.matches, [{ id: 'pricing', quotes: ['≈ 15 Comments'] }])
    globalThis.fetch = async () => Response.json({ choices: [{ message: { content: '{"matches":[{"id":"pricing","evidenceIds":[999]}]}' } }] })
    const invalid = await verifyHelpCitations('question', 'answer', documents)
    assert.equal(invalid.status === 'unavailable' && invalid.reason, 'invalid_evidence')
    globalThis.fetch = async () => Response.json({ choices: [{ message: { content: 'not json' } }] })
    const malformed = await verifyHelpCitations('question', 'answer', documents)
    assert.equal(malformed.status === 'unavailable' && malformed.reason, 'invalid_response')
  } finally {
    globalThis.fetch = originalFetch
    for (const key of ['OPENAI_API_KEY', 'OPENAI_TEXT_MODEL', 'OPENAI_BASE_URL']) {
      if (before[key] === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = before[key]
    }
  }
})

test('verified Help Center links keep their own origin in Markdown and bare URLs', () => {
  const source = { id: 'help', title: 'Account requirements', url: 'https://help.example.com/help/abc123-account',
    content: 'Public accounts only. Read [account details](/help/abc123-account) and [support](/help/def456-support).' }
  const answer = 'Read [account details](https://product.example.com/help/abc123-account) or https://product.example.com/help/abc123-account and https://unverified.example.com/claim'
  assert.equal(removeUnverifiedAnswerLinks(answer, [source], new Set(['help'])),
    'Read [account details](https://help.example.com/help/abc123-account) or https://help.example.com/help/abc123-account and ')
  assert.equal(removeUnverifiedAnswerLinks('[support](https://help.example.com/help/def456-support)', [source], new Set(['help'])),
    '[support](https://help.example.com/help/def456-support)')
  assert.equal(removeUnverifiedAnswerLinks(answer, [source], new Set()), 'Read account details or  and ')
  assert.equal(removeUnverifiedAnswerLinks('See <https://product.example.com/help/abc123-account> or https://help.example.com/help/abc123-account.', [source], new Set(['help'])),
    'See <https://help.example.com/help/abc123-account> or https://help.example.com/help/abc123-account.')
  assert.equal(removeUnverifiedAnswerLinks('See <https://unverified.example.com/claim>.', [source], new Set()), 'See .')
  assert.equal(removeUnverifiedAnswerLinks('Manage: https://product.example.com/subscriptions', [], new Set(), ['https://product.example.com/subscriptions']),
    'Manage: https://product.example.com/subscriptions', 'an actually read public navigation page does not need a factual citation card')
})

test('citation selection stays small and its model budget is independent of the main Agent', () => {
  const source = { sourceType: 'web_page', id: '00000000-0000-4000-8000-000000000001' }
  assert.equal(citationSourcesInput.safeParse({ sources: [source] }).success, true)
  assert.equal(citationSourcesInput.safeParse({ sources: Array(4).fill(source) }).success, false)
  assert.deepEqual(citationReasoningOptions('gpt-5.4'), { reasoning_effort: 'none' })
  assert.deepEqual(citationReasoningOptions('gpt-5.4-2026-03-05'), { reasoning_effort: 'none' })
  assert.deepEqual(citationReasoningOptions('gpt-5.4', 'low'), { reasoning_effort: 'low' })
  assert.deepEqual(citationReasoningOptions('gpt-5', 'none'), { reasoning_effort: 'low' })
  assert.deepEqual(citationReasoningOptions('other-model'), {})
})

test('citation review cannot rewrite final answers or treat conversation context as public evidence', async () => {
  const before = { ...process.env }, originalFetch = globalThis.fetch
  Object.assign(process.env, { OPENAI_API_KEY: 'test', OPENAI_TEXT_MODEL: 'gpt-5.4', OPENAI_BASE_URL: 'https://example.invalid/v1' })
  try {
    const context = { historyComplete: true, messages: [
      { role: 'user', text: 'I use Document Translator on the Plus plan.' },
      { role: 'assistant', text: 'Your feedback has been created. The previous screenshot identified the tool.' },
    ] }
    const answer = 'Your feedback has been created. On Document Translator the documented upload limit applies.'
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(init!.body as string)
      assert.equal(request.reasoning_effort, 'none')
      const input = JSON.parse(request.messages[1].content)
      assert.deepEqual(input.context, context)
      assert.equal(input.answer, answer)
      assert.match(request.messages[0].content, /no authority to rewrite/)
      assert.match(request.messages[0].content, /contradictory public website/)
      return Response.json({ choices: [{ message: { content: JSON.stringify({ revisedAnswer: 'Forget the completed action.', matches: [] }) } }] })
    }
    const verdict = await verifyHelpCitations('What about 30 pages?', answer, candidates, { context })
    assert.equal(verdict.status, 'verified')
    assert.equal('revisedAnswer' in verdict, false)
    assert.deepEqual(verdict.matches, [])
    assert.equal(answer, 'Your feedback has been created. On Document Translator the documented upload limit applies.')
    globalThis.fetch = async () => { throw new Error('Provider unavailable') }
    const failed = await verifyHelpCitations('question', answer, candidates, { context })
    assert.equal(failed.status, 'unavailable')
    assert.deepEqual(keepVerifiedHelpReferences([{ type: 'text', text: answer }, { type: 'article_reference', articles: [{ article_id: 'answer', title: 'Answer', slug: 'answer' }] }], new Set(failed.matches.map(match => match.id))), [{ type: 'text', text: answer }])
  } finally {
    globalThis.fetch = originalFetch
    for (const key of ['OPENAI_API_KEY', 'OPENAI_TEXT_MODEL', 'OPENAI_BASE_URL']) {
      if (before[key] === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = before[key]
    }
  }
})
