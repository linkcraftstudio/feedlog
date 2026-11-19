import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cloudflareEmailProvider, type SendEmailBinding } from '../server/utils/email-cloudflare'

const mail = { to: 'a@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi', headers: { 'List-Unsubscribe': '<https://example.com/u>' }, idempotencyKey: 'k1' }

test('the provider hands the message to the EMAIL binding', async () => {
  const sent: unknown[] = []
  const binding: SendEmailBinding = { send: async (message) => { sent.push(message); return { messageId: 'm1' } } }
  await cloudflareEmailProvider('noreply@example.com', () => binding).send(mail)
  assert.deepEqual(sent, [{ from: { email: 'noreply@example.com', name: 'FeedLog' }, to: 'a@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi', headers: { 'List-Unsubscribe': '<https://example.com/u>' } }])
})

test('the provider needs EMAIL_FROM and the binding', async () => {
  assert.throws(() => cloudflareEmailProvider(undefined, () => undefined), /EMAIL_FROM required/)
  await assert.rejects(cloudflareEmailProvider('noreply@example.com', () => undefined).send(mail), /EMAIL binding missing/)
})

test('a binding error reaches the caller', async () => {
  const failure = Object.assign(new Error('Sender domain not verified'), { code: 'E_SENDER_NOT_VERIFIED' })
  const binding: SendEmailBinding = { send: async () => { throw failure } }
  await assert.rejects(cloudflareEmailProvider('noreply@example.com', () => binding).send(mail), failure)
})
