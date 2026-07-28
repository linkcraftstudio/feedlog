// Clickjacking guard. The widget's embed page must be framable by any customer
// site — we have no registry of their hosts — while every other page (dashboard,
// portal, auth) has no reason to be framed at all, so it is denied outright.
//
// CSP frame-ancestors rather than X-Frame-Options: the latter has no
// "allow any origin" value, only DENY/SAMEORIGIN, so it cannot express the
// widget case. Modern browsers prefer frame-ancestors where both are present.
//
// Known gap: Nitro's own error responses carry a hardcoded CSP that replaces
// this one, so a 404/500 on the embed path loses `frame-ancestors *` and the
// customer's iframe renders blank instead of showing the error.
const EMBED_PATH = '/widget/embed'

export default defineEventHandler((event) => {
  // event.path carries the query string, so compare against the pathname only.
  const path = event.path.split('?')[0] ?? ''

  // API routes are not framable surfaces; a header there is noise.
  if (path.startsWith('/api/')) return

  const framable = path === EMBED_PATH || path.startsWith(`${EMBED_PATH}/`)
  setResponseHeader(
    event,
    'Content-Security-Policy',
    framable ? 'frame-ancestors *' : 'frame-ancestors \'none\'',
  )
})
