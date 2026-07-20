/**
 * Resolve a storage key (e.g. "uploads/img.png") to a serveable URL.
 * Keys starting with "http" or "/" are returned as-is (already resolved).
 */
export function resolveAttachmentUrl(key: string | null | undefined): string | null {
  if (!key) return null
  if (key.startsWith('blob:')) return null
  if (key.startsWith('http') || key.startsWith('/')) return key
  return `/api/files/${key}`
}

const ATTACHMENT_MD_RE = /(!\[[^\]]*\]\()attachment:([^)]+)(\))/g
const ATTACHMENT_HTML_RE = /(src=["'])attachment:([^"']+)(["'])/g

/**
 * Replace attachment: protocol URLs in markdown image syntax.
 * For use before passing markdown to MdPreview.
 *
 * e.g. ![alt](attachment:uploads/img.png) → ![alt](/api/files/uploads/img.png)
 */
export function resolveAttachmentUrls(markdown: string): string {
  return markdown.replace(ATTACHMENT_MD_RE, (_m, pre, key, post) => `${pre}/api/files/${encodeURI(key)}${post}`)
}

/**
 * Replace attachment: protocol URLs in rendered HTML (img src).
 * For use as MdEditor's sanitize prop to handle preview pane.
 *
 * e.g. <img src="attachment:uploads/img.png"> → <img src="/api/files/uploads/img.png">
 */
export function sanitizeAttachmentHtml(html: string): string {
  return html.replace(ATTACHMENT_HTML_RE, '$1/api/files/$2$3')
}
