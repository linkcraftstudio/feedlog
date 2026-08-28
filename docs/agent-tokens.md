# Agent tokens

A long-lived credential that lets a machine — a script, a bot, an AI agent — work a FeedLog board
over ordinary HTTP, without a browser and without a person signing in every week.

## Why this exists

Every write endpoint is gated by a better-auth session, and sessions expire. That is right for
people and wrong for machines: a scheduled job that files cards, or an agent that triages the
backlog, cannot re-authenticate itself. The workarounds are both bad — leave a human re-signing in
on a schedule, or write straight to the database and quietly desynchronise vote tallies,
duplicate-detection embeddings, subscriptions, notifications and the activity trail.

## How it works

An agent token **is** a better-auth session, minted with a far-future expiry and presented as
`Authorization: Bearer <token>`.

That is the whole design, and it is why the patch is small. The `bearer()` plugin rewrites the
header into a session cookie before any better-auth endpoint runs, so an agent authenticates
through exactly the same path as a browser. Every existing gate works unmodified:

| Gate | Works because |
|---|---|
| `getUserSession` | bearer resolves the session normally |
| `requireAuthInOrg` | same |
| `requireOrgMember` | `customSession` still runs, so `orgList` is present |
| `requireOrgPermission` | delegates to `auth.api.hasPermission`, which bearer also covers |

**`server/utils/auth.ts` is not modified by this feature.** If a change starts spreading into the
auth helpers, the approach has gone wrong.

### Why not the `apiKey` plugin

better-auth ships an API-key plugin, and it is the obvious candidate. It does not fit:

- Its mocked session **short-circuits `/get-session`**, so the `customSession` handler never runs
  and `orgList` is never attached — every `requireOrgMember` route would refuse the agent. This is
  upstream's deliberate design, confirmed in
  [#9769](https://github.com/better-auth/better-auth/issues/9769) and
  [#7312](https://github.com/better-auth/better-auth/issues/7312) (*"Session created by api keys
  are mocks… we generally recommend to avoid using session for api keys"*).
- Its rate limit defaults to **10 requests per day per key**, applied to every endpoint once
  session mocking is on.
- In 1.5.x it is a separate package with an **exact** peer pin on the better-auth version.

### The robot account

Each token gets its own user row, created server-side, under the reserved `.invalid` domain:

- **No `account` row** — no password, no linked provider, so there is no way in through the login
  form. A sign-in attempt is refused exactly like a non-existent account.
- **Role `manager` or `contributor`, never `owner`.**
- Its own identity per token, so revoking one token cannot affect another, and the Members page
  shows one removable row per agent.

Server-side provisioning is required rather than convenient: sign-up may require e-mail
verification and a robot has no inbox, and the invitation flow deliberately does not auto-accept —
the invitee must sign in and click Accept, which a credential-less identity can never do.

## Using it

Mint under **Developer → Agent tokens** (owner only). The token is shown once; there is no reveal
endpoint, which is what makes it show-once. Lost tokens are revoked and replaced.

```bash
curl https://board.example.com/api/posts \
  -H "Authorization: Bearer $FEEDLOG_TOKEN"
```

**Never put the token in a URL.** `server/plugins/access-log.ts` logs every request's path *and*
query string, so a token in a query parameter lands in the container log in clear text.

## What an agent may not do

Three limits, each enforced in a different place and for a different reason.

**Never an owner.** The role choice excludes it.

**Never manages people.** `server/middleware/sso-session-guard.ts` blocks agent identities from
better-auth's own `/api/auth/organization/*` and `/api/auth/admin/*` endpoints. Those sit outside
FeedLog's `requireOrg*` gates, so a `manager`-level agent could otherwise invite members and change
roles — including its own. Agents join the SSO and guest identities already blocked there.

**Deletes only if granted.** Deleting is the one action nobody can undo, so it is a per-token
capability rather than something bundled into `manager`. Off by default; grant it at creation or
afterwards, and withdraw it at any time — `server/middleware/agent-delete-guard.ts` reads the flag
per request, so a withdrawal bites on the very next call and the token itself never has to be
re-issued.

The guard gates deleting *content* — cards, comments, boards, changelog entries. Deletes that only
unwind the caller's own action, such as withdrawing a vote or unsubscribing, stay allowed: those
are participation, not destruction, and gating them would stop an agent taking back its own upvote.

## Revocation

Revoking deletes the underlying session, so the token stops working on the **very next request**.
The 60-second session cookie cache never applies: a bearer client sends no cookie, so every request
does a live database lookup.

The robot's user row is left behind on purpose, so anything it wrote keeps a valid author. Removing
the identity entirely is the Members page's job, and cascades the token rows.

## On storage

The token is a better-auth session token, stored the way every session token already is —
recoverable by anyone with database access. That is the same exposure as every signed-in human on
the deployment, not a new class of risk, and it is stated plainly rather than dressed up: hashing
would require owning the lookup, which would mean not reusing the session path, which is the whole
point. There is no constant-time comparison here because nothing is compared here; better-auth
looks the session up by indexed key, exactly as it does for a browser.

## Verification

The repository has no test framework, and this feature did not add one — a Nuxt/Nitro harness plus
a Postgres fixture plus a session-faking pattern would be a far larger diff than the feature. What
it adds instead is `scripts/agent-token-probe.ts`, a live HTTP probe, because the claim being tested
is precisely *"a real request carrying this header behaves like a signed-in human"* and only a real
request can show that.

```bash
FEEDLOG_URL=http://localhost:3000 \
FEEDLOG_AGENT_TOKEN=... \
FEEDLOG_POST_ID=... \
pnpm dlx tsx scripts/agent-token-probe.ts
```

### Results

Run against a throwaway PostgreSQL 17 + pgvector database with a `manager` token. **13 passed, 0
failed.**

| # | Tier / check | Expected | Result |
|---|---|---|---|
| 1 | Public read, no auth | 200 | pass |
| 2 | Bearer session resolves **with `orgList`** | 200, agent identity, role `manager` | pass |
| 3 | `requireAuthInOrg` — vote | 2xx | pass |
| 4 | `requireAuthInOrg` — comment | 2xx | pass |
| 5 | `requireOrgMember` — admin card list | 200 | pass |
| 6 | `requireOrgPermission` — set card status | 200 | pass |
| 7 | `requireOrgPermission` — create changelog | 201 | pass |
| 8 | `requireOrgPermission` — publish changelog | 200 | pass |
| 9 | Owner-only surface refuses the agent | 403 | pass |
| 10 | Org management refuses the agent | 403 | pass |
| 11 | Delete refused without the capability | 403, **from the capability guard** | pass |
| 12 | Withdrawing a vote still allowed | 2xx | pass |
| 13 | Bogus token refused | 401 | pass |

Step 2 is the one that rules out the `apiKey` plugin: `orgList` is present, which a mocked
API-key session never has. Step 6 is the one most likely to fail on a wrong design, because it is
the only tier that re-resolves the caller inside better-auth via `hasPermission`.

### Checked by hand, beyond the probe

**Lifetime.** A token requested for 90 days was recorded with an expiry 90 days out, not the 7-day
session default — confirming the `overrideAll` argument to `internalAdapter.createSession` is
required and effective. A far expiry also suppresses better-auth's rolling refresh, so the row is
never rewritten and the token string never changes.

**Delete capability, full cycle**, one token throughout, never re-minted:

| Step | Result |
|---|---|
| Mint without the capability | `allowDelete = false` |
| Delete a card | 403 |
| Owner grants the capability | `allowDelete = true` |
| Delete the same card | 204, and the card returns 404 afterwards |
| Owner withdraws the capability | `allowDelete = false` |
| Delete another card | 403, immediately |

**Revocation.** After revoking, every authenticated endpoint returned 401 and `/api/auth/get-session`
returned `200` with a `null` body — byte-identical to an anonymous request. The token row and the
session row were both gone; the robot's user row remained, as designed.

**No login path.** The robot has zero `account` rows, and a sign-in attempt with its address returns
`401 Invalid email or password` — the same response as an address that was never registered.

**Bookkeeping.** This is the reason for going through the endpoints rather than the database. After
an agent created a card, voted, commented and merged a duplicate, the database showed real `vote`
and `comment` rows (not merely incremented counters), the threaded reply carried its `parent_id`,
the merged card carried `merged_to`, and the merge had generated its own activity-trail row of type
`mergedPost` — authored by the agent, without being asked. A direct database write would have
produced none of it.

**Migration.** Both migrations are additive: one `CREATE TABLE agent_token`, one
`ALTER TABLE … ADD COLUMN allow_delete`. No existing table is altered otherwise. Applied on boot via
the existing `server/plugins/migrate.ts` advisory-lock path against a live deployment with existing
content, with no data loss.

**Build.** `pnpm build` completes and `pnpm i18n:check` passes (`en` ⇄ `zh` parity). The repository
has pre-existing type errors in ~20 upstream files; none of the files added or changed here appear
in that list.
