#!/usr/bin/env tsx
// End-to-end probe for agent tokens.
//
// The claim being tested is narrow and specific: "a plain HTTP request carrying
// `Authorization: Bearer <agent token>` is treated exactly as a signed-in human
// would be, at every gate tier the app actually has". Only a real request over
// the wire can show that, so this is a live probe rather than a unit test — and
// it is why the patch ships one instead of introducing a test framework the
// repository has never had.
//
// Each step maps to one authorisation tier in server/utils/auth.ts. Step 5 is
// the decisive one: requireOrgPermission delegates to auth.api.hasPermission,
// which re-resolves the caller from the raw headers inside better-auth. If the
// bearer plugin did not cover that path, this is where it would fail.
//
// Usage:
//   FEEDLOG_URL=http://localhost:3000 \
//   FEEDLOG_AGENT_TOKEN=... \
//   pnpm dlx tsx scripts/agent-token-probe.ts
//
// Writes only a comment and a vote on a post you name, plus a draft changelog
// entry it publishes. Point it at a board you don't mind marking.

const BASE = (process.env.FEEDLOG_URL || 'http://localhost:3000').replace(/\/$/, '')
const TOKEN = process.env.FEEDLOG_AGENT_TOKEN || ''
const POST_ID = process.env.FEEDLOG_POST_ID || ''

if (!TOKEN) {
  console.error('FEEDLOG_AGENT_TOKEN is required')
  process.exit(1)
}

// The token goes in a header and nowhere else. server/plugins/access-log.ts
// writes each request's path AND query string to the container log, so a token
// passed as `?token=` would be printed in plain text on the server.
const authHeaders = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

let passed = 0
let failed = 0

async function step(
  name: string,
  run: () => Promise<{ ok: boolean; detail?: string }>,
): Promise<void> {
  try {
    const { ok, detail } = await run()
    if (ok) {
      passed++
      console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`)
    }
    else {
      failed++
      console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    }
  }
  catch (e) {
    failed++
    console.log(`  FAIL  ${name} — threw: ${(e as Error).message}`)
  }
}

async function req(
  path: string,
  init: RequestInit & { anon?: boolean } = {},
): Promise<{ status: number; body: unknown }> {
  const { anon, ...rest } = init
  const res = await fetch(`${BASE}${path}`, {
    ...rest,
    headers: anon ? { 'Content-Type': 'application/json' } : { ...authHeaders, ...(rest.headers || {}) },
  })
  const text = await res.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  }
  catch { /* non-JSON error pages stay as text */ }
  return { status: res.status, body }
}

async function main() {
  console.log(`Probing ${BASE}\n`)

  // Tier 0 — no authentication. Proves the board is up and org context resolves.
  await step('public read (no auth)', async () => {
    const { status } = await req('/api/boards', { anon: true })
    return { ok: status === 200, detail: `status ${status}` }
  })

  // Tier 1 — the token is recognised at all, AND customSession ran. orgList is
  // the field requireOrgMember reads; its presence here is the single fact that
  // rules out the API-key approach, whose mocked session never gets it.
  let agentRole = ''
  await step('bearer session resolves, with orgList', async () => {
    const { status, body } = await req('/api/auth/get-session')
    const b = body as { user?: { email?: string }, orgList?: { role: string }[] }
    agentRole = b?.orgList?.[0]?.role ?? ''
    const isAgent = !!b?.user?.email?.endsWith('@agents.feedlog.invalid')
    return {
      ok: status === 200 && isAgent && !!agentRole,
      detail: `status ${status}, agent=${isAgent}, role=${agentRole || 'none'}`,
    }
  })

  // Tier 2 — requireAuthInOrg (23 call sites). Going through the endpoint is
  // what keeps the vote tally, subscriptions and activity trail correct; a
  // direct database write would have skipped all of it.
  if (POST_ID) {
    await step('requireAuthInOrg — vote', async () => {
      const { status } = await req(`/api/posts/${POST_ID}/vote`, { method: 'POST' })
      return { ok: status >= 200 && status < 300, detail: `status ${status}` }
    })
    await step('requireAuthInOrg — comment', async () => {
      const { status } = await req(`/api/posts/${POST_ID}/comments`, {
        method: 'POST',
        body: JSON.stringify({ content: 'Agent token probe.' }),
      })
      return { ok: status >= 200 && status < 300, detail: `status ${status}` }
    })
  }
  else {
    console.log('  SKIP  requireAuthInOrg — set FEEDLOG_POST_ID to exercise write tiers')
  }

  // Tier 3 — requireOrgMember (7 call sites), which reads session.orgList.
  await step('requireOrgMember — admin post list', async () => {
    const { status } = await req('/api/admin/posts')
    return { ok: status === 200, detail: `status ${status}` }
  })

  // Tier 4 — requireOrgPermission { feedlog: ['moderate'] } (20 call sites).
  // The decisive check: this is the one that goes through auth.api.hasPermission.
  const moderator = agentRole === 'manager' || agentRole === 'owner'
  if (POST_ID && moderator) {
    await step('requireOrgPermission — set post status', async () => {
      const { status } = await req(`/api/admin/posts/${POST_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'planned' }),
      })
      return { ok: status === 200, detail: `status ${status}` }
    })
  }

  // Changelog create + publish, the other half of the stated goal.
  let changelogId = ''
  if (moderator) {
    await step('requireOrgPermission — create changelog', async () => {
      const { status, body } = await req('/api/admin/changelogs', {
        method: 'POST',
        body: JSON.stringify({ title: 'Agent token probe', content: 'Written by the probe script.' }),
      })
      changelogId = (body as { id?: string })?.id ?? ''
      return { ok: status >= 200 && status < 300 && !!changelogId, detail: `status ${status}` }
    })
    if (changelogId) {
      await step('requireOrgPermission — publish changelog', async () => {
        const { status } = await req(`/api/admin/changelogs/${changelogId}/publish`, { method: 'POST' })
        return { ok: status >= 200 && status < 300, detail: `status ${status}` }
      })
    }
  }

  // Negative control — the agent is a manager, not an owner. If this ever
  // returns 200 the role ceiling has stopped holding.
  await step('owner-only surface refuses the agent', async () => {
    const { status } = await req('/api/developer/sso/secrets')
    return { ok: status === 403, detail: `status ${status} (expected 403)` }
  })

  // Escalation control — better-auth's own org endpoints sit outside FeedLog's
  // gates, so a manager could otherwise invite members and change roles. This
  // is what the sso-session-guard extension blocks.
  await step('cannot reach org management', async () => {
    const { status } = await req('/api/auth/organization/invite-member', {
      method: 'POST',
      body: JSON.stringify({ email: 'probe@example.com', role: 'member' }),
    })
    return { ok: status === 403, detail: `status ${status} (expected 403)` }
  })

  // The delete capability. A token is minted without it, so a delete must be
  // refused with 403 — and the refusal must come from the capability guard, not
  // from the role, which is why a manager-level token is used for this.
  if (POST_ID) {
    await step('delete is refused without the capability', async () => {
      const { status, body } = await req(`/api/admin/posts/${POST_ID}`, { method: 'DELETE' })
      const msg = (body as { message?: string })?.message ?? ''
      const fromCapability = msg.includes('not allowed to delete')
      return {
        ok: status === 403 && fromCapability,
        detail: `status ${status}${fromCapability ? ', refused by the capability guard' : `, message: ${msg}`}`,
      }
    })
    console.log('  NOTE  grant the capability in the dashboard and re-run to see the delete succeed')
  }

  // Withdrawing a vote is a DELETE too, and must stay allowed — it unwinds the
  // agent's own action rather than destroying anyone's content.
  if (POST_ID) {
    await step('withdrawing a vote is still allowed', async () => {
      const { status } = await req(`/api/posts/${POST_ID}/vote`, { method: 'DELETE' })
      return { ok: status >= 200 && status < 300, detail: `status ${status}` }
    })
  }

  // A garbage token must be refused cleanly — 401, never a 500 and never a
  // silent success.
  await step('bogus token is refused', async () => {
    const res = await fetch(`${BASE}/api/admin/posts`, {
      headers: { Authorization: 'Bearer not-a-real-token' },
    })
    return { ok: res.status === 401 || res.status === 403, detail: `status ${res.status}` }
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (POST_ID) {
    console.log('\nStill to check by hand:')
    console.log('  - the token list shows an expiry ~as requested (proves the lifetime override took)')
    console.log('  - revoke the token in the dashboard, re-run: every authenticated step must 401')
  }
  process.exit(failed ? 1 : 0)
}

void main()
