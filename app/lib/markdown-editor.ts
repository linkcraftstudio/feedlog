import { getSchema, mergeAttributes, type JSONContent, type NodeViewRenderer } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Code from '@tiptap/extension-code'
import CodeBlock from '@tiptap/extension-code-block'
import { LegacyHtmlImageBlock, supportedFigure, LegacyContainer, LegacyContainerTitle, LegacyAnchor, LegacyFigure, LegacyFigureImage, LegacyCaption, legacyFigurePattern, legacyAnchorPattern, legacyImagePattern, htmlAttributes } from './markdown-legacy-nodes'
import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import { TableKit } from '@tiptap/extension-table'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Markdown, MarkdownManager } from '@tiptap/markdown'
import { resolveAttachmentUrl, markdownImage, prepareLegacyAttachments } from '../utils/attachment'

// Storage keys are opaque. Resolve them only for the DOM, never in persisted MD.
export const AttachmentImage = Image.extend({
  addAttributes() { return { ...this.parent?.(), width: { default: null }, height: { default: null }, html: { default: false, rendered: false } } },
  markdownTokenizer: {
    name: 'image', level: 'inline', start: src => src.indexOf('<img'),
    tokenize(src) { const match = legacyImagePattern.exec(src); if (match) return { type: 'image', raw: match[0], htmlAttrs: htmlAttributes(match[0]) } },
  },
  parseMarkdown(token, helpers) {
    return helpers.createNode('image', token.htmlAttrs ? { ...token.htmlAttrs, html: true } : { src: token.href, alt: token.text || null, title: token.title || null })
  },
  renderHTML({ HTMLAttributes }) {
    const stored = String(HTMLAttributes.src ?? '')
    const src = stored.startsWith('attachment:')
      ? resolveAttachmentUrl(stored.slice('attachment:'.length))
      : /^(https?:\/\/|\/)/i.test(stored) ? stored : null
    return ['img', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { src })]
  },
  renderMarkdown(node) {
    if (node.attrs?.html) {
      const escape = (value: unknown) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      return `<img${['src', 'alt', 'title', 'width', 'height'].filter(key => node.attrs?.[key] != null).map(key => ` ${key}="${escape(node.attrs![key])}"`).join('')}>`
    }
    return markdownImage({ src: String(node.attrs?.src ?? ''), alt: node.attrs?.alt, title: node.attrs?.title })
  },
}).configure({ inline: true, allowBase64: false })

const MarkdownLink = Link.extend({
  parseMarkdown(token, helpers) {
    // Explicit Markdown links (including internationalized URLs) are untouched.
    // GFM's bare-link lexer may swallow a Chinese sentence after punctuation.
    if (/^https?:\/\//.test(token.raw ?? '') && /[。，！？；：、]/.test(token.raw ?? '')) {
      return { type: 'text', text: token.raw }
    }
    return helpers.applyMark('link', helpers.parseInline(token.tokens || []), {
      href: token.href, title: token.title || null,
    })
  },
}).configure({ openOnClick: false, autolink: false, defaultProtocol: 'https' })

const CompatibleCode = Code.extend({ excludes: '' })
const CompatibleCodeBlock = CodeBlock.extend({
  renderMarkdown(node) {
    const text = (node.content ?? []).map(child => child.text ?? '').join('')
    const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map(run => run.length))
    const fence = '`'.repeat(longest + 1)
    return `${fence}${node.attrs?.language ?? ''}\n${text}\n${fence}`
  },
})

export function markdownExtensions(codeView?: NodeViewRenderer) {
  return [
    StarterKit.configure({ link: false, code: false, codeBlock: false, underline: false, trailingNode: false }),
    CompatibleCode, codeView ? CompatibleCodeBlock.extend({ addNodeView() { return codeView } }) : CompatibleCodeBlock,
    LegacyHtmlImageBlock, LegacyContainer, LegacyContainerTitle, LegacyAnchor, LegacyFigure, LegacyFigureImage, LegacyCaption,
    MarkdownLink,
    AttachmentImage,
    TableKit.configure({ table: { resizable: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
  ]
}

export function createMarkdownManager() {
  return new MarkdownManager({
    extensions: markdownExtensions(), markedOptions: { gfm: true, breaks: true },
  })
}

export function parseMarkdownDocument(source: string, manager: MarkdownManager): JSONContent {
  const json = manager.parse(prepareLegacyAttachments(source))
  function normalize(node: JSONContent) {
    // Empty Markdown list items still need an editable paragraph in the schema.
    if (['listItem', 'taskItem'].includes(node.type ?? '') && !node.content?.length) node.content = [{ type: 'paragraph' }]
    if (!node.content) return
    node.content.forEach(normalize)
    // Marked emits a stand-alone image as a top-level node, whereas our schema
    // permits inline images to retain surrounding text. Wrap only block parents.
    if (['doc', 'blockquote', 'listItem', 'taskItem', 'tableCell', 'tableHeader', 'legacyContainer'].includes(node.type ?? '')) {
      node.content = node.content.map(child => child.type === 'image'
        ? { type: 'paragraph', content: [child] } : child)
    }
  }
  normalize(json)
  if (!json.content?.length) json.content = [{ type: 'paragraph' }]
  return canonicalDocument(json)
}

/** Preserve unsupported dialects as editable source instead of losing content.
 * This is a native textarea fallback, not a second rich-text editor. Detection
 * is deliberately conservative. A false positive is preferable to data loss.
 */
export function requiresSourcePreservation(source: string): boolean {
  const prose = source.replace(/^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\2[^\n]*$/gm, '')
    .replace(/(`+)[^\n]*?\1/g, '')
    .replace(/!\[[^\]\n]*\]\(<attachment:[^\n]*?>\)/g, '')
  const supported = prose
    .replace(new RegExp(legacyFigurePattern.source.replace('^', ''), 'g'), match => supportedFigure(match) ? '' : match)
    .replace(new RegExp(legacyAnchorPattern.source.replace('^', ''), 'g'), '')
    .replace(new RegExp(legacyImagePattern.source.replace('^', ''), 'g'), '')
    .replace(/^:::[ \t]*(?:(?:tip|warning|info|danger|details|code-group)(?:[ \t]+[^\n]*)?)?[ \t]*$/gm, '')
  return /<\/?[A-Za-z!][^>]*>|\[\^[^\]]+\]|^\s*\[[^\]]+\]:|\$\$|\$[^\n$]+\$|^ {0,3}:::(?:[ \t]|$)|==[^\n]+==|(?<!~)~[^~\n]+~(?!~)|\^[^\n^]+\^/m.test(supported)
}

// ProseMirror canonicalizes mark order and default attributes. Compare that
// semantic representation rather than incidental parser property/mark ordering.
export function canonicalDocument(json: JSONContent): JSONContent {
  return getSchema(markdownExtensions()).nodeFromJSON(json).toJSON()
}

export type MarkdownDocument = { source: string, json: JSONContent, sourceOnly: boolean }

export function loadMarkdown(source: string, manager: MarkdownManager): MarkdownDocument {
  if (requiresSourcePreservation(source)) {
    return { source, json: { type: 'doc', content: [{ type: 'paragraph' }] }, sourceOnly: true }
  }
  try {
    const json = parseMarkdownDocument(source, manager)
    getSchema(markdownExtensions()).nodeFromJSON(json).check()
    // Reject an unstable conversion rather than accepting a lossy document.
    const exported = manager.serialize(json)
    const reparsed = parseMarkdownDocument(exported, manager)
    return { source, json, sourceOnly: JSON.stringify(json) !== JSON.stringify(reparsed) }
  } catch {
    return { source, json: { type: 'doc', content: [{ type: 'paragraph' }] }, sourceOnly: true }
  }
}

/** Retain byte-identical original content on load, selection changes and undo. */
export function serializeMarkdown(json: JSONContent, loaded: MarkdownDocument, manager: MarkdownManager): string {
  return JSON.stringify(json) === JSON.stringify(loaded.json) ? loaded.source : manager.serialize(json)
}

export function withinMarkdownLimit(next: string, previous: string, limit?: number): boolean {
  // An existing over-limit document must remain readable and reducible.
  return !limit || next.length <= limit || next.length <= previous.length
}
