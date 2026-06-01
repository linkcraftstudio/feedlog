// Single source for Markdown→plain-text — server excerpts/search/embeddings and
// client og:description share it, so the stripping rules can't drift apart.
export function stripMarkdown(text: string): string {
  return text
    // Remove code blocks
    .replace(/```[\s\S]*?```/g, '')
    // Remove headings
    .replace(/^#{1,6}\s+/gm, '')
    // Remove images
    .replace(/!\[.*?\]\(.*?\)/g, '')
    // Remove links, keep text
    .replace(/\[([^\]]*)\]\(.*?\)/g, '$1')
    // Remove bold/italic markers
    .replace(/[*_]{1,3}(.+?)[*_]{1,3}/g, '$1')
    // Remove strikethrough
    .replace(/~~(.+?)~~/g, '$1')
    // Remove inline code
    .replace(/`(.+?)`/g, '$1')
    // Remove blockquotes
    .replace(/^>\s+/gm, '')
    // Remove horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, '')
    // Remove table pipe characters and alignment markers
    .replace(/\|/g, ' ')
    .replace(/^[-: ]+$/gm, '')
    // Remove HTML tags
    .replace(/<[^>]+>/g, '')
    // Remove list markers
    .replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/^[\s]*\d+\.\s+/gm, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim()
}

// Generate excerpt from Markdown content (strip syntax, take first 200 characters)
export function generateExcerpt(content: string, maxLength = 200): string {
  const plain = stripMarkdown(content)
  return plain.length > maxLength ? plain.slice(0, maxLength) : plain
}
