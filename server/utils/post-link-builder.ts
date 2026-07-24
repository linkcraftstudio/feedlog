// Where a notification email's deep-link points — a layer↔app seam. The link must
// name the recipient's canonical host, not whichever host triggered the send, so it
// never reads the request directly; SaaS overrides it to {orgSlug}.{ROOT_DOMAIN}.
// The caller passes the full path (/p/{slug} or /changelog/{slug}) so one seam
// covers every entity, plus the triggering request's origin as a fallback.
export type PostLinkBuilder = (orgSlug: string, path: string, requestOrigin?: string) => string

// BETTER_AUTH_URL is optional in OSS (README: inferred from the request Host), so
// prefer explicit config, then the origin the request actually arrived on. With
// neither, throw: the caller logs and drops the mail, which beats emailing a link
// to a host the recipient can't reach — that one can't be taken back.
const defaultBuilder: PostLinkBuilder = (_orgSlug, path, requestOrigin) => {
  const baseUrl = process.env.BETTER_AUTH_URL || requestOrigin
  if (!baseUrl) throw new Error('[post-link] no base URL: set BETTER_AUTH_URL or pass requestOrigin')
  return `${baseUrl}${path}`
}

let _builder: PostLinkBuilder = defaultBuilder

export function registerPostLinkBuilder(builder: PostLinkBuilder): void {
  _builder = builder
}

export function buildPostLink(orgSlug: string, path: string, requestOrigin?: string): string {
  return _builder(orgSlug, path, requestOrigin)
}
