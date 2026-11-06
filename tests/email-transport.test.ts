import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hasEmailTransport } from '../server/utils/email'

test('a Resend key or the Cloudflare provider can deliver mail, and nothing else', () => {
  assert.equal(hasEmailTransport({}), false)
  assert.equal(hasEmailTransport({ RESEND_API_KEY: 'key' }), true)
  assert.equal(hasEmailTransport({ EMAIL_PROVIDER: 'cloudflare' }), true)
  assert.equal(hasEmailTransport({ EMAIL_PROVIDER: 'resend' }), false)
  assert.equal(hasEmailTransport({ EMAIL_PROVIDER: 'console' }), false)
})
