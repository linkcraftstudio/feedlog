// Generic SEO directives do not block user-requested knowledge imports.
// An explicit directive for our crawler still applies across comma-separated rules.
export function blocksWebSourceIndexing(header = '') {
  let applies = false
  return header.split(',').some(part => {
    const target = /^\s*([\w-]+):\s*(.*)$/.exec(part)
    if (target && !/^(?:max-snippet|max-image-preview|max-video-preview|unavailable_after)$/i.test(target[1]!)) applies = target[1]!.toLowerCase() === 'feedlogbot'
    return applies && /\b(noindex|none)\b/i.test(target ? target[2]! : part)
  })
}
