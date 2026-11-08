import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveWidgetLocale, widgetLocaleRequest } from '../shared/utils/widget-locale'

test('legacy default embed uses browser languages rather than portal preferences', () => {
  const input = widgetLocaleRequest(undefined, '/widget/embed')
  assert.equal(input, 'auto')
  assert.equal(resolveWidgetLocale(input, ['zh-CN', 'en-US']), 'zh')
  assert.equal(resolveWidgetLocale(input, ['en-US', 'zh-CN']), 'en')
  assert.equal(resolveWidgetLocale(input, ['fr-FR', 'ko-KR']), 'en')
})

test('existing Chinese embed paths remain explicit, while an SDK locale overrides the route', () => {
  assert.equal(resolveWidgetLocale(widgetLocaleRequest(undefined, '/zh/widget/embed'), ['en']), 'zh')
  assert.equal(resolveWidgetLocale(widgetLocaleRequest('en', '/zh/widget/embed'), ['zh']), 'en')
  assert.equal(resolveWidgetLocale(widgetLocaleRequest('auto', '/zh/widget/embed'), ['en']), 'en')
  assert.equal(widgetLocaleRequest(['zh', 'en'], '/widget/embed'), 'auto')
})

test('regional language tags use existing Chinese or English text without adding translations', () => {
  for (const tag of ['zh-CN', 'zh-TW', 'zh-Hant', 'ZH-hk']) assert.equal(resolveWidgetLocale(tag, ['en']), 'zh')
  for (const tag of ['en', 'en-GB', 'en-US', 'fr', 'ko', 'unsupported']) assert.equal(resolveWidgetLocale(tag, ['zh']), 'en')
  assert.equal(resolveWidgetLocale('auto', []), 'en')
})
