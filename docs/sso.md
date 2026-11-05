# JWT SSO and external authentication

FeedLog accepts an identity asserted by a trusted application at
`GET /api/sso/jwt`. The organization SSO secret is managed in FeedLog's
dashboard. Keep that secret on the trusted application's server; never expose it
to browser JavaScript.

## Delegate FeedLog login and signup

Set one or both external authentication URLs:

```bash
EXTERNAL_LOGIN_URL=https://app.example.com/login
EXTERNAL_SIGNUP_URL=https://app.example.com/signup
```

An ordinary login action then navigates to a URL like:

```text
https://app.example.com/login?return_to=https%3A%2F%2Ffeedback.example.com%2Fp%2Froadmap%3Fb%3Dmobile
```

FeedLog derives `return_to` from its current page; it never accepts an external
destination from a browser query parameter. It preserves ordinary page query
parameters, removes credential-shaped parameters and fragments, and requires a
validated configured HTTPS endpoint (with a loopback-only HTTP exception for
local development).

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

The signup endpoint follows the same pattern after account creation. The external
application owns authentication and JWT signing; the redirect feature adds no
new authentication protocol and does not change FeedLog's JWT verification or
session behavior.

Use a short JWT lifetime, transmit it only over HTTPS, avoid logging request
query strings on the SSO route, and rotate the organization SSO secret if it is
ever exposed.
