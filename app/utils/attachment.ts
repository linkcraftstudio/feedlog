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

// encodeURI leaves # ? ( ) alone, and each ends the link early: # and ? start a
// fragment or query, ) closes the markdown destination.
function encodeKey(key: string): string {
  return encodeURI(key)
    .replace(/#/g, '%23')
    .replace(/\?/g, '%3F')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
}

// The old uploader emitted destinations containing unescaped spaces. Only fix
// the known attachment convention; never rewrite normal URLs or code samples.
export function prepareLegacyAttachments(source: string): string {
  // A fence remains code through EOF even when the closing fence is absent.
  // Buffer prose so inline code spans can also cross line boundaries.
  let fence: { marker: string, length: number } | undefined
  let prose = ''
  let result = ''
  const flush = () => {
    result += prose.split(/((`+)(?!`)[\s\S]*?(?<!`)\2(?!`))/g)
      // Captured delimiter groups are not part of the output.
      .filter((_part, index) => index % 3 !== 2)
      .map((part, index) => index % 2 ? part : part.replace(
        /(!\[[^\]\n]*\]\()attachment:([^\n]*?\.[A-Za-z0-9]{2,5})\)/g,
        (_match, prefix, key) => `${prefix}<attachment:${key}>)`,
      )).join('')
    prose = ''
  }
  for (const line of source.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*?)(?:\r?\n)?$/.exec(line)
    if (fence) {
      result += line
      if (marker && marker[1]![0] === fence.marker && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined
    } else if (marker && !(marker[1]![0] === '`' && marker[2]!.includes('`'))) {
      flush()
      fence = { marker: marker[1]![0]!, length: marker[1]!.length }
      result += line
    } else if (/^(?: {4}|\t)/.test(line)) {
      flush()
      result += line
    } else {
      prose += line
    }
  }
  flush()
  return result
}

export function markdownImage(image: { src: string, alt?: string | null, title?: string | null }) {
  const alt = (image.alt ?? '').replace(/[\\[\]]/g, '\\$&')
  const title = (image.title ?? '').replace(/[\\"]/g, '\\$&')
  const destination = /[\s()]/.test(image.src) ? `<${image.src}>` : image.src
  return `![${alt}](${destination}${title ? ` "${title}"` : ''})`
}
