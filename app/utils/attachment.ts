/**
 * Resolve a storage key (e.g. "uploads/img.png") to a serveable URL.
 * Keys starting with "http" or "/" are returned as-is (already resolved).
 */
export function resolveAttachmentUrl(key: string | null | undefined): string | null {
  if (!key) return null
  if (key.startsWith('blob:')) return null
  if (key.startsWith('http') || key.startsWith('/')) return key
  return `/api/files/${encodeKey(key)}`
}

// A key holds spaces AND parentheses — "Screenshot (1).png" is what every OS
// calls a duplicate — so the first branch runs to ".ext)" rather than stopping
// at the first ")". The second is the old rule, for keys with no extension.
const ATTACHMENT_MD_RE = /(!\[[^\]]*\]\()attachment:(.+?\.[A-Za-z0-9]{2,5}|[^)]+)(\))/g
const ATTACHMENT_HTML_RE = /(src=["'])attachment:([^"']+)(["'])/g

// encodeURI leaves # ? ( ) alone, and each ends the link early: # and ? start a
// fragment or query, ) closes the markdown destination.
function encodeKey(key: string): string {
  return encodeURI(key)
    .replace(/#/g, '%23')
    .replace(/\?/g, '%3F')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
}

/**
 * Replace attachment: protocol URLs in markdown image syntax.
 * For use before passing markdown to MdPreview.
 *
 * e.g. ![alt](attachment:uploads/img.png) → ![alt](/api/files/uploads/img.png)
 */
export function resolveAttachmentUrls(markdown: string): string {
  return markdown.replace(ATTACHMENT_MD_RE, (_m, pre, key, post) => `${pre}/api/files/${encodeKey(key)}${post}`)
}

/**
 * Replace attachment: protocol URLs in rendered HTML (img src).
 * For use as MdEditor's sanitize prop to handle preview pane.
 *
 * e.g. <img src="attachment:uploads/img.png"> → <img src="/api/files/uploads/img.png">
 */
export function sanitizeAttachmentHtml(html: string): string {
  return html.replace(ATTACHMENT_HTML_RE, (_m, pre, key, post) => `${pre}/api/files/${encodeKey(key)}${post}`)
}
