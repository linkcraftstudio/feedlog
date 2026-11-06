import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { emailBrandName } from '../server/utils/email-brand'
import { formatSender, registerEmailProvider, sendEmail, type SendEmailOptions } from '../server/utils/email'
import { invitationSubject, renderInvitationEmail } from '../server/utils/email-templates'
import { emailSamples } from './fixtures/email-samples'

const globals = globalThis as Record<string, unknown>
const organization = (name: string | null) => { globals.getOrgInfo = async () => name === null ? null : { name } }

test('with a brand name, no email names FeedLog or its contacts', () => {
  for (const mail of emailSamples('Acme & Sons')) assert.ok(!/feedlog/i.test(mail), mail.slice(0, 300))
  const named = emailSamples('Acme & Sons').filter(mail => mail.includes('Acme &amp; Sons') || mail.includes('Acme & Sons'))
  assert.equal(named.length, 12)
})

test('an invitation does not name the organization twice', () => {
  const html = renderInvitationEmail({ url: 'https://example.invalid/x', orgName: 'Acme', brandName: 'Acme' })
  assert.ok(html.includes('>Join Acme</h2>'))
  assert.ok(!html.includes('Acme on Acme'))
})

test('without a brand name, every email is unchanged', () => {
  assert.deepEqual(emailSamples(), JSON.parse(readFileSync(new URL('./fixtures/email-unbranded.json', import.meta.url), 'utf8')))
})

test('the brand name is the organization name, and nothing for the unnamed default organization', async () => {
  organization('Acme')
  assert.equal(await emailBrandName(), 'Acme')
  organization('Default')
  assert.equal(await emailBrandName(), undefined)
  organization(null)
  assert.equal(await emailBrandName(), undefined)
  globals.getOrgInfo = async () => { throw new Error('database down') }
  assert.equal(await emailBrandName(), undefined)
})

test('an email is sent under the brand name, and a given sender name wins', async () => {
  const sent: SendEmailOptions[] = []
  process.env.EMAIL_PROVIDER = 'capture'
  registerEmailProvider({ name: 'capture', send: async (options) => { sent.push(options) } })
  organization('Acme')
  await sendEmail({ to: 'a@example.com', subject: 's', html: 'h' })
  await sendEmail({ to: 'a@example.com', subject: 's', html: 'h', fromName: 'Billing' })
  organization('Default')
  await sendEmail({ to: 'a@example.com', subject: 's', html: 'h' })
  assert.deepEqual(sent.map(options => options.fromName), ['Acme', 'Billing', undefined])
})

test('a sender name with a comma, a quote or a line break cannot change the From header', () => {
  assert.equal(formatSender('a@example.com'), 'FeedLog <a@example.com>')
  assert.equal(formatSender('a@example.com', 'Acme'), '"Acme" <a@example.com>')
  assert.equal(formatSender('a@example.com', 'Acme, Inc "x"\r\nBcc: b@example.com'), '"Acme, Inc xBcc: b@example.com" <a@example.com>')
})

test('an invitation subject names the organization once, and FeedLog only without a brand name', () => {
  assert.equal(invitationSubject('Team'), "You're invited to join Team on FeedLog")
  assert.equal(invitationSubject('Team', 'Acme'), "You're invited to join Team on Acme")
  assert.equal(invitationSubject('Acme', 'Acme'), "You're invited to join Acme")
})
