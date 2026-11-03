import assert from 'node:assert/strict'
import { test } from 'node:test'
import { publicItem } from '../server/lib/agent/runtime'
import { handoffCustomerNotice } from '../shared/inbox/state'

const handoff = (reason: string) => ({
  id: 'handoff:test', seq: 2, author_type: 'system',
  content: { parts: [{ type: 'system_event', kind: 'handoff', reason, fromStatus: 'ai_handling', toStatus: 'open' }] },
  created_at: '2026-10-21T00:00:00Z',
})

test('Missing-AI handoffs stay hidden when the customer reloads history', () => {
  assert.equal(publicItem(handoff('ai_error')), null)
})

test('manual takeover records stay internal when the customer reloads history', () => {
  const row = handoff('manual')
  row.id = 'cmd:manual-takeover'
  row.content.parts[0]!.kind = 'takeover'
  assert.equal(publicItem(row), null)
})

test('a pending takeover is internal and does not announce human handling before AI finishes', () => {
  const row = handoff('manual')
  row.content.parts[0]!.kind = 'takeover_requested'
  row.content.parts[0]!.toStatus = 'ai_handling'
  assert.equal(publicItem(row), null)
})

test('requested and rule handoffs keep their existing customer notice', () => {
  for (const reason of ['user_requested', 'support_rule']) {
    assert.equal(publicItem(handoff(reason))?.notice, 'handoff')
  }
})


test('rule handoffs expose only the matching notice category and public text', () => {
  const cases = [
    ['builtin-billing', 'handoffBilling', 'billing'],
    ['builtin-account-access', 'handoffAccount', 'account'],
    ['builtin-privacy-legal', 'handoffPrivacy', 'request'],
    ['custom-rule', 'handoffRule', 'further assistance'],
  ]
  for (const [id, category, text] of cases) {
    const row = handoff('support_rule')
    Object.assign(row.content.parts[0], { rule: { id, scenario: 'Private internal routing instruction' } })
    const item = publicItem(row)
    assert.equal(item?.handoffNotice, category)
    assert.ok(JSON.stringify(item?.content).includes(text))
    assert.ok(!JSON.stringify(item).includes('Private internal routing instruction'))
  }
  assert.equal(publicItem(handoff('support_rule'))?.handoffNotice, 'handoffRule')
  assert.equal(publicItem(handoff('user_requested'))?.handoffNotice, 'handoff')
})

test('customer history preserves the saved conversation language without internal routing details', () => {
  for (const text of [
    '你的问题已转交人工客服。你可以继续在这里补充情况或截图。',
    'Your question has been passed to our support team. You can send more details or screenshots here.',
    'درخواست شما به تیم پشتیبانی ارجاع داده شد. می‌توانید جزئیات بیشتری را همین‌جا ارسال کنید.',
    'تم تحويل طلبك إلى فريق الدعم. يمكنك إرسال المزيد من التفاصيل هنا.',
    'ご質問をサポートチームに引き継ぎました。ここで詳細を追加できます。',
  ]) {
    const row = handoff('support_rule')
    Object.assign(row.content.parts[0], { customerNotice: text, rule: { id: 'private-rule', scenario: 'Private routing instruction' } })
    const item = publicItem(row)
    assert.equal(item?.customerNotice, text)
    assert.deepEqual(item?.content, { parts: [{ type: 'text', text }] })
    assert.doesNotMatch(JSON.stringify(item), /Private routing instruction|private-rule/)
  }
})

test('customer confirmation is bounded plain text and legacy events retain their fallback', () => {
  assert.equal(handoffCustomerNotice.parse('  A confirmation.  '), 'A confirmation.')
  for (const value of ['', '   ', 'x'.repeat(1001), null]) assert.equal(handoffCustomerNotice.safeParse(value).success, false)
  assert.equal(publicItem(handoff('user_requested'))?.customerNotice, undefined)
  const hidden = handoff('ai_error')
  Object.assign(hidden.content.parts[0], { customerNotice: 'Must stay hidden' })
  assert.equal(publicItem(hidden), null)
})
