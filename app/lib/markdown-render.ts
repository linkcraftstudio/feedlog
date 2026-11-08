import MarkdownIt from 'markdown-it'
import { markdownCodeBlock } from './markdown-code-view'
import subscript from 'markdown-it-sub'
import superscript from 'markdown-it-sup'
import sanitizeHtml from 'sanitize-html'
import { resolveAttachmentUrl, prepareLegacyAttachments } from '../utils/attachment'

const parser = new MarkdownIt({ html: true, breaks: true, linkify: true }).use(subscript).use(superscript)
parser.renderer.rules.fence = (tokens, index, _options, env) => {
  const token = tokens[index]!
  return markdownCodeBlock(token.content.replace(/\n$/, ''), token.info.trim().split(/\s+/)[0] ?? '', env.codeLabels)
}
parser.renderer.rules.code_block = (tokens, index, _options, env) => markdownCodeBlock(tokens[index]!.content.replace(/\n$/, ''), '', env.codeLabels)
// Attachment destinations are opaque storage keys, not already-encoded URLs.
const normalizeLink = parser.normalizeLink.bind(parser)
parser.normalizeLink = value => value.startsWith('attachment:') ? value : normalizeLink(value)
configurePreviewContainers(parser)
// Disabled task checkboxes are presentation, never interactive form inputs.
parser.core.ruler.after('inline', 'task_lists', state => {
  for (let index = 2; index < state.tokens.length; index++) {
    const token = state.tokens[index]!
    if (token.type !== 'inline' || state.tokens[index - 1]?.type !== 'paragraph_open' || state.tokens[index - 2]?.type !== 'list_item_open') continue
    const first = token.children?.[0]
    const match = first?.type === 'text' && /^\[([ xX])\] /.exec(first.content)
    if (!match || !first) continue
    first.content = first.content.slice(4)
    const checkbox = new state.Token('html_inline', '', 0)
    checkbox.content = `<input type="checkbox" disabled${match[1]!.toLowerCase() === 'x' ? ' checked' : ''}> `
    token.children!.unshift(checkbox)
  }
})

export function renderMarkdown(source: string, headingId?: (heading: { text: string, level: number, index: number }) => string, transform?: (html: string) => string, codeLabels: { collapse: string, plainText: string, copy?: string } = { collapse: 'Collapse or expand code', plainText: 'Plain text' }) {
  const env = { codeLabels }
  const tokens = parser.parse(prepareLegacyAttachments(source), env)
  let index = 0
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.type === 'heading_open') {
      const text = tokens[i + 1]?.content ?? ''
      token.attrSet('id', headingId?.({ text, level: Number(token.tag.slice(1)), index }) ?? `heading-${index}`)
      index++
    }
  }
  const html = parser.renderer.render(tokens, parser.options, env)
  // Run consumer transforms before the final safety boundary on both SSR and client.
  return sanitizeHtml(transform ? transform(html) : html, {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img', 'figure', 'figcaption', 'details', 'summary', 'input', 'del', 'button'],
    allowedAttributes: {
      '*': ['class', 'id', 'data-md-container', 'aria-hidden'], a: ['href', 'title', 'target', 'rel'],
      button: ['type', 'aria-label', 'aria-expanded', 'aria-live'],
      img: ['src', 'alt', 'title', 'width', 'height'], input: ['type', 'checked', 'disabled'],
      th: ['colspan', 'rowspan', 'align'], td: ['colspan', 'rowspan', 'align'], ol: ['start'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'], allowProtocolRelative: false,
    transformTags: { button: sanitizeHtml.simpleTransform('button', { type: 'button' }), img: (_tag, attrs) => ({ tagName: 'img', attribs: { ...attrs, ...(attrs.src?.startsWith('attachment:') ? { src: resolveAttachmentUrl(attrs.src.slice(11)) ?? '' } : {}) } }), a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }), input: (_tag, attrs) => ({ tagName: 'input', attribs: { type: 'checkbox', disabled: '', ...(Object.hasOwn(attrs, 'checked') ? { checked: '' } : {}) } }) },
  })
}

// Parse the same historical container syntax used by the structured editor.
// Work at block-token level so directives inside fenced code stay literal.
function configurePreviewContainers(md: MarkdownIt) {
  md.block.ruler.before('fence', 'legacy_container', (state, start, end, silent) => {
    const line = (index: number) => state.src.slice(state.bMarks[index]! + state.tShift[index]!, state.eMarks[index])
    const opening = /^:::\s*(tip|warning|info|danger|details|code-group)(?:[ \t]+(.*))?$/.exec(line(start))
    if (!opening) return false
    let depth = 1
    let stop = start + 1
    let fence: { char: string, length: number } | undefined
    for (; stop < end; stop++) {
      const text = line(stop)
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(text)
      if (fence) {
        if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined
      } else if (marker) fence = { char: marker[1]![0]!, length: marker[1]!.length }
      else if (/^:::\s*\S/.test(text)) depth++
      else if (/^:::\s*$/.test(text) && --depth === 0) break
    }
    if (stop === end) return false
    if (silent) return true
    const open = state.push('legacy_container_open', 'div', 1)
    open.attrSet('class', 'fdl-legacy-container')
    open.attrSet('data-md-container', opening[1]!)
    open.map = [start, stop + 1]
    const title = state.push('paragraph_open', 'p', 1)
    title.attrSet('class', 'fdl-container-title')
    const inline = state.push('inline', '', 0)
    inline.content = opening[2] || ''
    inline.children = []
    state.push('paragraph_close', 'p', -1)
    state.md.block.tokenize(state, start + 1, stop)
    state.push('legacy_container_close', 'div', -1)
    state.line = stop + 1
    return true
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] })
}
