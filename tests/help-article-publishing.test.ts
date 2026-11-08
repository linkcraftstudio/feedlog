import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHelpArticleSchema, updateHelpArticleSchema } from '../shared/schemas/help'

const article = { collectionId: '00000000-0000-4000-8000-000000000001', title: 'Getting started' }

test('single article saves reject missing or blank content in drafts and publications', () => {
  assert.equal(createHelpArticleSchema.safeParse(article).success, false)
  for (const content of ['', ' \n\r\t ', '\u00a0\u3000']) {
    for (const publish of [false, true]) {
      assert.equal(createHelpArticleSchema.safeParse({ ...article, content, publish }).success, false)
    }
    for (const status of [undefined, 'draft', 'published']) {
      assert.equal(updateHelpArticleSchema.safeParse({ content, status }).success, false)
    }
  }
})

test('valid Markdown keeps its whitespace and metadata-only updates remain valid', () => {
  for (const content of ['    indented code\n', '![Diagram](https://example.com/diagram.png)', '```sh\npnpm install\n```']) {
    assert.equal(createHelpArticleSchema.parse({ ...article, content }).content, content)
    assert.equal(updateHelpArticleSchema.parse({ content }).content, content)
  }
  assert.deepEqual(updateHelpArticleSchema.parse({ aiEnabled: false }), { aiEnabled: false })
})

test('long imported articles remain editable and saveable', () => {
  const content = 'a'.repeat(50001)
  assert.equal(createHelpArticleSchema.safeParse({ ...article, content }).success, true)
  assert.equal(updateHelpArticleSchema.safeParse({ content }).success, true)
})
