import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderInboxHandoffEmail } from '../server/utils/email-templates'

test('owner mail includes identity, summary, exact message and conversation link with escaped HTML', () => {
  const email = renderInboxHandoffEmail({ productName: 'Product', url: 'https://example.invalid/dashboard/inbox?conversationId=test',
    customerName: 'Alex <script>', customerEmail: 'alex@example.invalid', reason: 'Support rule · Billing & refunds',
    summary: 'Alex reports duplicate charges and requests a refund.', lastMessage: '<img src=x onerror=alert(1)> 请退回多扣的费用。', imageCount: 2 })
  assert.ok(email.html.includes('Alex &lt;script&gt;'))
  assert.ok(!email.html.includes('<img src=x'))
  assert.ok(email.html.includes('ISSUE SUMMARY'))
  assert.ok(email.html.includes('2 images attached'))
  assert.ok(email.text.includes('请退回多扣的费用。'))
  assert.ok(email.html.includes('conversationId=test'))
})
test('AI unavailable and image-only messages need no summary or synthetic visitor email', () => {
  const email = renderInboxHandoffEmail({ productName: 'Product', url: 'https://example.invalid/inbox', customerName: 'Visitor',
    reason: 'AI unavailable · Routed to your team', lastMessage: '', imageCount: 1 })
  assert.ok(email.html.includes('Visitor'))
  assert.ok(!email.html.includes('ISSUE SUMMARY'))
  assert.ok(email.html.includes('1 image attached'))
  assert.ok(!email.html.includes('undefined'))
})
