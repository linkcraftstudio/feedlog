import { Extension, Node, mergeAttributes, type JSONContent } from '@tiptap/core'

const escapeHtml = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const decodeHtml = (value: string) => value.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, key: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" })[key]!)

export function htmlAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const match of tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[match[1]!] = decodeHtml(match[2] ?? match[3] ?? '')
  return attrs
}

function inlineHtml(nodes: JSONContent[] = []): string {
  return nodes.map(node => {
    if (node.type === 'hardBreak') return '<br>'
    let text = escapeHtml(node.text)
    for (const mark of [...(node.marks ?? [])].reverse()) {
      const tag = { bold: 'strong', italic: 'em', strike: 's', code: 'code' }[mark.type]
      if (tag) text = `<${tag}>${text}</${tag}>`
      else if (mark.type === 'link') text = `<a href="${escapeHtml(mark.attrs?.href)}">${text}</a>`
    }
    return text
  }).join('')
}
// Captions are HTML text, not Markdown: literal asterisks must stay literal.
function captionContent(html: string): JSONContent[] | null {
  const content: JSONContent[] = []
  const stack: { tag: string, mark: NonNullable<JSONContent['marks']>[number] }[] = []
  for (const part of html.split(/(<[^>]*>)/g)) {
    if (!part) continue
    if (!part.startsWith('<')) { content.push({ type: 'text', text: decodeHtml(part), marks: stack.map(item => item.mark) }); continue }
    if (/^<br\s*\/?>$/.test(part)) { content.push({ type: 'hardBreak' }); continue }
    const close = /^<\/(strong|b|em|i|s|del|code|a)>$/.exec(part)
    if (close) { if (stack.pop()?.tag !== close[1]) return null; continue }
    const open = /^<(strong|b|em|i|s|del|code)>$/.exec(part)
    if (open) { stack.push({ tag: open[1]!, mark: { type: ({ strong: 'bold', b: 'bold', em: 'italic', i: 'italic', s: 'strike', del: 'strike', code: 'code' } as Record<string, string>)[open[1]!]! } }); continue }
    if (/^<a\s+href=(?:"[^"]*"|'[^']*')>$/.test(part)) { stack.push({ tag: 'a', mark: { type: 'link', attrs: { href: htmlAttributes(part).href } } }); continue }
    return null
  }
  return stack.length ? null : content
}

export const legacyFigurePattern = /^<figure(?:\s+class="[\w -]*")?>\s*(<img\s+[^>]*>)\s*<figcaption>([\s\S]*?)<\/figcaption>\s*<\/figure>/
export const legacyAnchorPattern = /^<span\s+id=(?:"[^"]*"|'[^']*')><\/span>/
export const legacyImagePattern = /^<img\s+(?:(?:src|alt|title|width|height)=(?:"[^"]*"|'[^']*')\s*)+\/?>/

export function supportedFigure(source: string): boolean {
  const match = legacyFigurePattern.exec(source)
  return !!match && legacyImagePattern.exec(match[1]!)?.[0] === match[1] && captionContent(match[2]!) !== null
}

export const LegacyHtmlImageBlock = Extension.create({
  name: 'legacyHtmlImageBlock',
  markdownTokenizer: {
    name: 'legacyHtmlImageBlock', level: 'block', start: src => src.search(/^<img\s/m),
    tokenize(src) { const match = legacyImagePattern.exec(src); if (match) return { type: 'legacyHtmlImageBlock', raw: match[0], attrs: htmlAttributes(match[0]) } },
  },
  parseMarkdown(token, helpers) { return helpers.createNode('paragraph', {}, [helpers.createNode('image', { ...token.attrs, html: true })]) },
})

export const LegacyContainerTitle = Node.create({
  name: 'legacyContainerTitle', content: 'inline*', defining: true,
  parseHTML() { return [{ tag: 'p[data-container-title]' }] },
  renderHTML() { return ['p', { 'data-container-title': '', class: 'fdl-container-title' }, 0] },
  renderMarkdown(node, helpers) { return helpers.renderChildren(node.content ?? []) },
})

export const LegacyContainer = Node.create({
  name: 'legacyContainer', group: 'block', content: 'legacyContainerTitle block+', defining: true,
  addAttributes() { return { kind: { default: 'tip' } } },
  parseHTML() { return [{ tag: 'div[data-md-container]', getAttrs: el => ({ kind: el.getAttribute('data-md-container'), title: el.getAttribute('data-title') ?? '' }) }] },
  renderHTML({ node, HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'fdl-legacy-container', 'data-md-container': node.attrs.kind }), 0]
  },
  markdownTokenizer: {
    name: 'legacyContainer', level: 'block', start: src => src.search(/^:::\s*(?:tip|warning|info|danger|details|code-group)\b/m),
    tokenize(src, _tokens, lexer) {
      const opening = /^:::\s*(tip|warning|info|danger|details|code-group)(?:[ \t]+([^\n]*))?\r?\n/.exec(src)
      if (!opening) return
      let depth = 1
      let offset = opening[0].length
      let fence: { char: string, length: number } | undefined
      for (const line of src.slice(offset).match(/[^\n]*\n|[^\n]+$/g) ?? []) {
        const marker = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line)
        if (fence) {
          if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined
        } else if (marker) fence = { char: marker[1]![0]!, length: marker[1]!.length }
        else if (/^:::\s*\S/.test(line)) depth++
        else if (/^:::\s*$/.test(line)) {
          depth--
          if (!depth) return { type: 'legacyContainer', raw: src.slice(0, offset + line.length), kind: opening[1], title: opening[2] ?? '', tokens: lexer.blockTokens(src.slice(opening[0].length, offset)) }
        }
        offset += line.length
      }
    },
  },
  parseMarkdown(token, helpers) {
    const content = helpers.parseChildren(token.tokens ?? [])
    return helpers.createNode('legacyContainer', { kind: token.kind }, [helpers.createNode('legacyContainerTitle', {}, helpers.parseInline(helpers.tokenizeInline?.(token.title ?? '') ?? [])), ...(content.length ? content : [{ type: 'paragraph' }])])
  },
  renderMarkdown(node, helpers) { const title = helpers.renderChildren(node.content?.[0]?.content ?? []); return `::: ${node.attrs?.kind}${title ? ` ${title}` : ''}\n${helpers.renderChildren(node.content?.slice(1) ?? [], '\n\n')}\n:::` },
})

export const LegacyAnchor = Node.create({
  name: 'legacyAnchor', group: 'block', atom: true,
  addAttributes() { return { id: { default: '' } } },
  parseHTML() { return [{ tag: 'span[id]' }] },
  renderHTML({ HTMLAttributes }) { return ['span', mergeAttributes(HTMLAttributes, { class: 'fdl-legacy-anchor', contenteditable: 'false' })] },
  markdownTokenizer: {
    name: 'legacyAnchor', level: 'block', start: src => src.indexOf('<span'),
    tokenize(src) { const match = legacyAnchorPattern.exec(src); if (match) return { type: 'legacyAnchor', raw: match[0], id: htmlAttributes(match[0]).id } },
  },
  parseMarkdown(token, helpers) { return helpers.createNode('legacyAnchor', { id: token.id }) },
  renderMarkdown(node) { return `<span id="${escapeHtml(node.attrs?.id)}"></span>` },
})

export const LegacyCaption = Node.create({
  name: 'legacyCaption', content: 'inline*', defining: true,
  parseHTML() { return [{ tag: 'figcaption' }] },
  renderHTML() { return ['figcaption', 0] },
  renderMarkdown(node) { return `<figcaption>${inlineHtml(node.content)}</figcaption>` },
})

export const LegacyFigureImage = Node.create({
  name: 'legacyFigureImage', atom: true,
  addAttributes() { return Object.fromEntries(['src', 'alt', 'title', 'width', 'height'].map(key => [key, { default: null }])) },
  parseHTML() { return [{ tag: 'figure > img' }] },
  renderHTML({ HTMLAttributes }) {
    const src = /^(https?:\/\/|\/)/i.test(HTMLAttributes.src ?? '') ? HTMLAttributes.src : null
    return ['img', mergeAttributes(HTMLAttributes, { src })]
  },
  renderMarkdown(node) { return `<img${Object.entries(node.attrs ?? {}).filter(([, value]) => value !== null).map(([key, value]) => ` ${key}="${escapeHtml(value)}"`).join('')}>` },
})

export const LegacyFigure = Node.create({
  name: 'legacyFigure', group: 'block', content: 'legacyFigureImage legacyCaption', defining: true,
  addAttributes() { return { class: { default: null } } },
  parseHTML() { return [{ tag: 'figure' }] },
  renderHTML({ HTMLAttributes }) { return ['figure', HTMLAttributes, 0] },
  markdownTokenizer: {
    name: 'legacyFigure', level: 'block', start: src => src.indexOf('<figure'),
    tokenize(src) {
      const match = legacyFigurePattern.exec(src)
      if (!match || !supportedFigure(src)) return
      return { type: 'legacyFigure', raw: match[0], figureClass: htmlAttributes(match[0].split('>')[0]!).class ?? null, image: htmlAttributes(match[1]!), caption: captionContent(match[2]!) }
    },
  },
  parseMarkdown(token, helpers) {
    return helpers.createNode('legacyFigure', { class: token.figureClass }, [helpers.createNode('legacyFigureImage', token.image), helpers.createNode('legacyCaption', {}, token.caption)])
  },
  renderMarkdown(node, helpers) { return `<figure${node.attrs?.class ? ` class="${escapeHtml(node.attrs.class)}"` : ''}>\n${helpers.renderChildren(node.content ?? [], '\n')}\n</figure>` },
})
