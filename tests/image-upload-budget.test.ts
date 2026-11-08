import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateNewImageBudget } from '../shared/agent/images'
const mib = 1024 * 1024

test('new image budget permits ten compressed images and rejects per-image, aggregate and count bypasses', () => {
  assert.doesNotThrow(() => validateNewImageBudget(Array(10).fill(mib)))
  assert.doesNotThrow(() => validateNewImageBudget([2 * mib]))
  assert.throws(() => validateNewImageBudget([2 * mib + 1]), /image_too_large/)
  assert.throws(() => validateNewImageBudget(Array(6).fill(2 * mib)), /image_total_too_large/)
  assert.throws(() => validateNewImageBudget(Array(11).fill(1)), /image_too_large/)
  assert.throws(() => validateNewImageBudget([NaN]), /image_too_large/)
})
