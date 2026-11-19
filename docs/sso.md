# Portal JWT SSO

FeedLog accepts an identity asserted by a trusted application at
`GET /api/sso/jwt`. The organization SSO secret is managed in FeedLog's
dashboard. Keep that secret on the trusted application's server; never expose it
to browser JavaScript.

## Configure portal login and signup

In **Dashboard → Settings → Portal**, set one or both external authentication
URLs. The setting belongs to the current organization and is stored with its
other portal metadata. If only one URL is configured, FeedLog uses it for both
login and signup.

Portal authentication is used only when a visitor signs in to submit feedback,
comment, or vote. Dashboard sign-in, invitations, MCP authorization, Google,
GitHub, and email/password authentication continue to use Better Auth directly.
An identity established through portal SSO cannot access the dashboard or staff
APIs, even if its email matches an existing organization member.

An ordinary login action then navigates to a URL like:

```text
https://app.example.com/login?return_to=https%3A%2F%2Ffeedback.example.com%2Fp%2Froadmap%3Fb%3Dmobile
```

FeedLog derives `return_to` from the current portal page; it never accepts an
external destination from a browser query parameter. It preserves ordinary page
query parameters, removes credential-shaped parameters and fragments, and
requires a validated HTTPS endpoint (with a loopback-only HTTP exception for
local development). Configured query parameters are retained, except FeedLog
owns and replaces `return_to`.

After authenticating the visitor, the external application's **server** signs a
short-lived JWT and redirects to FeedLog's existing SSO endpoint. FeedLog
validates `return_to` again and only allows a destination on its own host.

## Example external application handler

This simplified Express-style example uses `jose`. In a real application,
replace `requireUser` with the application's existing login/session middleware.

```ts
import { SignJWT } from 'jose'

const feedlogOrigin = new URL(process.env.FEEDLOG_URL!)
const ssoSecret = new TextEncoder().encode(process.env.FEEDLOG_SSO_SECRET!)

app.get('/login', requireUser, async (req, res) => {
  // Never trust return_to merely because FeedLog normally supplies it.
  let returnTo = new URL('/', feedlogOrigin)
  try {
    const candidate = new URL(String(req.query.return_to ?? '/'), feedlogOrigin)
    if (candidate.origin === feedlogOrigin.origin) returnTo = candidate
  }
  catch {
    // Keep the safe root fallback.
  }

  const jwt = await new SignJWT({
    email: req.user.email,
    name: req.user.name,
    picture: req.user.avatarUrl,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('5m')
    .sign(ssoSecret)

  const handoff = new URL('/api/sso/jwt', feedlogOrigin)
  handoff.searchParams.set('jwt', jwt)
  handoff.searchParams.set('return_to', returnTo.pathname + returnTo.search + returnTo.hash)
  res.redirect(handoff.toString())
})
```

The signup endpoint follows the same pattern after account creation. The
external application owns authentication and JWT signing. FeedLog reuses the
existing organization-specific JWT verification and marks the resulting session
as portal-only.

Use a short JWT lifetime, transmit it only over HTTPS, avoid logging request
query strings on the SSO route, and rotate the organization SSO secret if it is
ever exposed.
