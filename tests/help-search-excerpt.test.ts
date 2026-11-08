import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildHelpExcerpt, splitHelpQuery } from '../server/utils/help-search'

test('Agent excerpt shows the body passage that answers a multi-term question', () => {
  const body = 'Aster Sync is a fictional test feature, not a product promise. ' +
    'The feature prepares scheduled project exports. ' +
    'When Aster Sync is paused, new scheduled exports stop immediately. ' +
    'Exports completed before the pause remain downloadable for 19 calendar days. '
  const tokens = splitHelpQuery('Aster Sync paused exports download existing exports')
  const first = buildHelpExcerpt(body, null, tokens)
  const best = buildHelpExcerpt(body, null, tokens, { bestMatch: true })
  assert.ok(!first.excerpt.includes('19 calendar days'))
  assert.ok(best.excerpt.includes('19 calendar days'))
  assert.ok(best.excerpt.includes('paused'))
})
