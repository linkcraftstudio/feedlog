import assert from 'node:assert/strict'
import { test } from 'node:test'
import { owner, manager, contributor } from '../shared/auth/permissions'
import { canVisitDashboard, dashboardEntry } from '../shared/auth/dashboard'

test('contributors can handle Inbox without gaining content or organization administration', () => {
  for (const role of [owner, manager, contributor]) assert.equal(role.authorize({ feedlog: ['inbox'] }).success, true)
  assert.equal(contributor.authorize({ feedlog: ['moderate'] }).success, false)
  assert.equal(contributor.authorize({ organization: ['delete'] }).success, false)
})

test('dashboard skips inaccessible Inbox and protects restricted navigation', () => {
  const reader = { member: true, inbox: false, moderate: false, owner: false }
  assert.equal(dashboardEntry(reader), '/dashboard/feedback')
  assert.equal(canVisitDashboard('/dashboard/inbox/', reader), false)
  assert.equal(canVisitDashboard('/dashboard/ai-agent', reader), true)
  for (const route of ['/dashboard/settings/widget', '/dashboard/ai-agent/chat', '/dashboard/ai-agent/deploy/']) {
    assert.equal(canVisitDashboard(route, reader), false)
    assert.equal(canVisitDashboard(route, { ...reader, moderate: true }), true)
  }
  assert.equal(canVisitDashboard('/dashboard/developer/sso', reader), false)
  assert.equal(canVisitDashboard('/dashboard/help', reader), true)
  assert.equal(dashboardEntry({ ...reader, inbox: true }), '/dashboard/inbox')
  assert.equal(dashboardEntry({ ...reader, member: false }), '/')
  assert.equal(canVisitDashboard('/dashboard/developer/sso', { ...reader, owner: true }), true)
})
