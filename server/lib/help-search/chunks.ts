import { Tiktoken } from 'js-tiktoken/lite'
import cl100k from 'js-tiktoken/ranks/cl100k_base'
import { HelpEmbeddingError } from './embedding'
let encoder: Tiktoken | undefined
const tokens = () => encoder ??= new Tiktoken(cl100k)
export interface HelpChunk { ordinal: number; heading: string; body: string; input: string }
// Keep code and table text: these often carry the answer. Drop images and URL noise.
export function cleanHelpText(text: string) {
  return text.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '').replace(/\r\n/g, '\n').trim()
}
export function chunkHelpArticle(article: { title: string; description: string | null; content: string }): HelpChunk[] {
  // Fail explicitly instead of silently indexing a truncated article.
  if (article.content.length > 500000) throw new HelpEmbeddingError('article_too_large', false)
  const enc = tokens(), chunks: HelpChunk[] = [], headings: string[] = []
  const sections: { heading: string; body: string }[] = []
  let body: string[] = [], fence = ''
  const flush = () => { if (body.join('\n').trim()) sections.push({ heading: headings.filter(Boolean).join(' > '), body: body.join('\n').trim() }); body = [] }
  for (const line of cleanHelpText(article.content).split('\n')) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)
    if (marker) { if (!fence) fence = marker[1]![0]!; else if (marker[1]![0] === fence) fence = '' }
    const heading = !fence && line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) { flush(); headings.length = heading[1]!.length - 1; headings[headings.length] = heading[2]! }
    else body.push(line)
  }
  flush()
  if (!sections.length) sections.push({ heading: '', body: article.title })
  for (const section of sections) {
    // Prefix also has a hard budget; content itself is never truncated.
    const prefixTokens = enc.encode([article.title, article.description, section.heading].filter(Boolean).join('\n'), [], []).slice(0, 160)
    while (prefixTokens.length && enc.decode(prefixTokens).endsWith('\ufffd')) prefixTokens.pop()
    const prefix = enc.decode(prefixTokens) + '\n\n'
    const encoded = enc.encode(section.body, [], [])
    for (let start = 0; start < encoded.length; start += 432) {
      // Byte tokens may split a Unicode character. Expand boundaries until decoding is lossless.
      let begin = start, end = Math.min(start + 512, encoded.length)
      while (begin > 0 && enc.decode(encoded.slice(begin, end)).startsWith('\ufffd')) begin--
      while (end < encoded.length && enc.decode(encoded.slice(begin, end)).endsWith('\ufffd')) end++
      const text = enc.decode(encoded.slice(begin, end))
      chunks.push({ ordinal: chunks.length, heading: section.heading, body: text, input: prefix + text })
      if (chunks.length > 128) throw new HelpEmbeddingError('too_many_chunks', false)
      if (end >= encoded.length) break
    }
  }
  return chunks
}
