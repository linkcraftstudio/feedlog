import assert from 'node:assert/strict'
import { test } from 'node:test'
import { searchHelpProgressively } from '../server/lib/help-search/progressive'

// Model calls must be controlled by search state, not merely by query language.
test('progressive search gates translation on Chinese, zero hits and explicit retry', async () => {
  const keys = ['HELP_SEARCH_BILINGUAL', 'OPENAI_API_KEY', 'OPENAI_TEXT_MODEL'] as const
  const before = { ...process.env }
  Object.assign(process.env, { HELP_SEARCH_BILINGUAL: 'true', OPENAI_API_KEY: 'test', OPENAI_TEXT_MODEL: 'test' })
  let calls = 0
  const rewrite = async () => { calls++; return { mode: 'bilingual' as const, queries: ['cancel subscription'] } }
  try {
    const first = await searchHelpProgressively({ orgId: 'test', query: '关闭自动续费', translate: false, search: async () => [], rewrite })
    assert.equal(first.canTranslate, true)
    assert.equal(calls, 0)
    const existing = await searchHelpProgressively({ orgId: 'test', query: '取消订阅', translate: true, search: async () => ['published'], rewrite })
    assert.deepEqual(existing.rows, ['published'])
    assert.equal(calls, 0)
    await searchHelpProgressively({ orgId: 'test', query: 'cancel subscription', translate: true, search: async () => [], rewrite })
    assert.equal(calls, 0)
    const retry = await searchHelpProgressively({ orgId: 'test', query: '关闭自动续费', translate: true, search: async phrases => phrases ? ['target'] : [], rewrite })
    assert.equal(calls, 1)
    assert.deepEqual(retry.rows, ['target'])
    assert.equal(retry.searchMode, 'bilingual')
    const failed = await searchHelpProgressively({ orgId: 'test', query: '关闭自动续费', translate: true, search: async () => [], rewrite: async () => ({ mode: 'fallback' }) })
    assert.equal(failed.searchMode, 'fallback')
    assert.deepEqual(failed.rows, [])
    process.env.HELP_SEARCH_BILINGUAL = 'false'
    const disabled = await searchHelpProgressively({ orgId: 'test', query: '关闭自动续费', translate: true, search: async () => [], rewrite })
    assert.equal(disabled.canTranslate, false)
    assert.equal(calls, 1)
  }
  finally {
    for (const key of keys) {
      if (before[key] === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = before[key]
    }
  }
})
