import { parseDocument, DomUtils } from 'htmlparser2'
import { createHash } from 'node:crypto'
import { CrawlError, normalizeWebSourceUrl } from './fetch'

type Node = ReturnType<typeof parseDocument>['children'][number]
const tag = (node: Node) => 'name' in node ? node.name.toLowerCase() : ''
const attrs = (node: Node): Record<string, string> => 'attribs' in node ? node.attribs : {}
const children = (node: Node): Node[] => 'children' in node ? node.children : []
const walk = (node: Node): Node[] => [node, ...children(node).flatMap(walk)]
const dropped = new Set(['script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'form', 'iframe', 'svg', 'canvas', 'template', 'button', 'input', 'textarea', 'select', 'option'])
const droppedRoles = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'dialog', 'alertdialog', 'menu', 'menubar', 'listbox', 'tooltip'])
const parents = (node: Node) => {
  const result: Node[] = []
  for (let p = node.parent; p; p = p.parent) result.push(p)
  return result
}
const chrome = (node: Node) => ['nav', 'footer', 'aside', 'form', 'dialog'].includes(tag(node)) || droppedRoles.has(attrs(node).role ?? '') || attrs(node)['aria-modal'] === 'true'

function protectedEmail(value: string | undefined) {
  if (!value || !/^(?:[a-f\d]{2}){3,256}$/i.test(value)) return undefined
  try {
    const key = parseInt(value.slice(0, 2), 16)
    const bytes = Uint8Array.from(value.slice(2).match(/../g)!, pair => parseInt(pair, 16) ^ key)
    const email = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined
  } catch { return undefined }
}

// Visibility is a UI state, not a reliable test of whether text is knowledge.
// Recover static disclosure panels and descriptive hover text before filtering;
// retain global navigation/dialog exclusions and never execute page scripts.
function prepareContentTree(nodes: Node[]) {
  const byId = new Map(nodes.filter(n => attrs(n).id).map(n => [attrs(n).id!, n]))
  const labelled = new Map<string, Node>()
  for (const n of nodes) for (const id of (attrs(n)['aria-labelledby'] ?? '').split(/\s+/).filter(Boolean)) labelled.set(id, n)
  const descriptions = new Map<Node, string>(), resolved = new Set<Node>()
  const show = (node: Node) => {
    const a = attrs(node)
    delete a.hidden; delete a['aria-hidden']
    if (a.style) a.style = a.style.replace(/(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important)?\s*;?/gi, '')
  }
  for (const n of nodes) {
    if (tag(n) === 'header' && parents(n).some(p => ['main', 'article', 'section'].includes(tag(p))) && !droppedRoles.has(attrs(n).role ?? '')) {
      if ('name' in n) n.name = 'section'
    }
  }
  const excluded = (n: Node) => [n, ...parents(n)].some(p => chrome(p) || tag(p) === 'header')
  for (const n of nodes) {
    if (excluded(n)) continue
    const a = attrs(n), name = tag(n), text = DomUtils.textContent(n).replace(/\s+/g, ' ').trim()
    // Native find-in-page disclosures are deliberately searchable while closed.
    if (a.hidden === 'until-found' && text.length >= 20) show(n)
    if (['button', 'a', 'summary'].includes(name) || ['button', 'tab'].includes(a.role ?? '')) {
      const target = (a['aria-controls'] && byId.get(a['aria-controls'])) || (a.id && labelled.get(a.id))
      const hasHeading = walk(n).some(p => /^h[1-6]$/.test(tag(p)))
      const disclosure = a.role === 'tab' || !!target && ['tabpanel', 'region'].includes(attrs(target).role ?? '')
        || !!text && (/[?？]/.test(text) || hasHeading || parents(n).some(p => /^h[1-6]$/.test(tag(p))))
      const panel = disclosure && a.role !== 'combobox' && target && !excluded(target) && DomUtils.textContent(target).trim().length >= 20
        && !walk(target).some(p => ['input', 'form'].includes(tag(p))) ? target : undefined
      if (panel) {
        // A hidden wrapper can sit between a labelled panel and its trigger.
        const common = new Set(parents(n))
        for (let p: Node | null = panel; p && !common.has(p); p = p.parent) show(p)
        resolved.add(n)
      }
      const faq = /[?？]/.test(text) && text.length >= 8 && (hasHeading || parents(n).some(p => /faq|accordion|collapse/i.test(attrs(p).class ?? '') || attrs(p)['data-slot'] === 'item'))
      if (text && text.length <= 300 && (panel || faq) && name === 'button' && 'name' in n) {
        n.name = hasHeading ? 'div' : parents(n).some(p => /^h[1-6]$/.test(tag(p))) ? 'span' : 'h3'
      }
    }
    // Some product step descriptions are hidden until hover, but already have
    // a nearby heading and full server-rendered prose. Explicit hidden/ARIA
    // nodes remain excluded unless linked to a disclosure above.
    if (name === 'p' && !('hidden' in a) && a['aria-hidden'] !== 'true' && text.length >= 30
      && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(a.style ?? '')
      && n.parent && children(n.parent).some(p => /^h[1-6]$/.test(tag(p)))) show(n)
    const tooltip = a['aria-describedby']?.split(/\s+/).map(id => byId.get(id)).find(p => p && attrs(p).role === 'tooltip')
    const description = (tooltip ? DomUtils.textContent(tooltip) : a['aria-label'] ?? a.title ?? '').trim()
    if (description.length >= 30 && (tooltip || a['aria-describedby'] || !text && name === 'button')) descriptions.set(n, description)
  }
  // Some static accordions have no ARIA relationship: a clickable question
  // and a hidden answer are the only two elements in a single item. Recover
  // that bounded pair, without making arbitrary hidden page content visible.
  for (const panel of nodes) {
    if (!hidden(panel) || excluded(panel) || !panel.parent) continue
    const siblings = children(panel.parent).filter(n => !!tag(n))
    if (siblings.length !== 2 || siblings[1] !== panel) continue
    const question = siblings[0]!, a = attrs(question)
    const text = DomUtils.textContent(question).replace(/\s+/g, ' ').trim()
    const answer = DomUtils.textContent(panel).trim()
    const clickable = ['button', 'summary'].includes(tag(question)) || a.role === 'button'
      || a['aria-expanded'] === 'false' || /(?:^|\s)cursor-pointer(?:\s|$)/.test(a.class ?? '')
    if (!clickable || hidden(question) || text.length < 8 || text.length > 300 || !/[?？]\s*$/.test(text)
      || answer.length < 20 || answer.length > 10000
      || walk(panel).some(n => chrome(n) || ['input', 'textarea', 'select'].includes(tag(n)))) continue
    show(panel)
    resolved.add(question)
    if (tag(question) === 'button' && 'name' in question) question.name = walk(question).some(n => /^h[1-6]$/.test(tag(n))) ? 'div' : 'h3'
  }
  const ui = new Set<Node>()
  for (const n of nodes) {
    if (['pre', 'code', 'table', 'thead', 'tbody', 'tr', 'td', 'th'].includes(tag(n))
      || parents(n).some(p => ['pre', 'code', 'table'].includes(tag(p)))) continue
    const a = attrs(n), text = DomUtils.textContent(n).replace(/\s+/g, ' ').trim()
    // Empty input counters are runtime state, not published usage limits.
    if (/^[\p{L}\p{M}\s]{1,32}[:：]?\s*0\s*\/\s*[\d,]+$/u.test(text) && !/^h[1-6]$/.test(tag(n))) ui.add(n)
    if (/^0\s*\/\s*[\d,]+$/.test(text) && !parents(n).some(p => ['table', 'pre', 'code'].includes(tag(p)))
      && parents(n).slice(0, 5).some(p => walk(p).some(child => ['textarea', 'input'].includes(tag(child)) || attrs(child).contenteditable === 'true'))) ui.add(n)
    if (!text || children(n).some(p => tag(p))) continue
    if (a.role === 'button' && a.title === text && parents(n).slice(0, 2).some(p => walk(p).some(c => ['textarea', 'input'].includes(tag(c))))) ui.add(n)
    if (!/--\s*%/.test(text)) continue
    // Bound removal to an unheaded empty-result panel. A real article, pricing
    // table, code sample or neighbouring product section must remain intact.
    let panel: Node = n
    for (const p of parents(n)) {
      const descendants = walk(p), value = DomUtils.textContent(p).trim()
      if (value.length > 600 || descendants.some(c => /^(?:h[1-6]|article|section|table|pre|code|input|textarea)$/.test(tag(c)))) break
      panel = p
    }
    ui.add(panel)
  }
  return { descriptions, resolved, ui }
}

const hidden = (node: Node) => 'hidden' in attrs(node) || attrs(node)['aria-hidden'] === 'true'
  || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(attrs(node).style ?? '')
const invisible = (node: Node) => dropped.has(tag(node)) || hidden(node) || chrome(node)
function readableText(node: Node): string {
  return invisible(node) ? '' : node.type === 'text' ? node.data : children(node).map(readableText).join(' ')
}
function contentRoot(nodes: Node[]) {
  const body = nodes.find(n => tag(n) === 'body') ?? nodes[0]!
  const candidates = nodes.filter(n => (['main', 'article'].includes(tag(n)) || attrs(n).role === 'main') && ![n, ...parents(n)].some(invisible))
  const main = candidates.sort((a, b) => readableText(b).length - readableText(a).length)[0]
  if (!main) return body
  // Some product homepages wrap only the interactive tool in <main> and place
  // their documentation/FAQ in sibling sections. Keep those sections as well.
  let heading = false, prose = false
  const outside = (node: Node) => {
    if (node === main || invisible(node)) return
    if (/^h[1-6]$/.test(tag(node)) && readableText(node).trim()) heading = true
    if (['p', 'li', 'pre', 'table', 'dd', 'address'].includes(tag(node)) && readableText(node).trim()) prose = true
    for (const child of children(node)) outside(child)
  }
  outside(body)
  // A short price or refund condition is important even beside a long article.
  return heading && prose ? body : main
}

export function inspectWebSourcePage(html: string, url: string) {
  const nodes = walk(parseDocument(html, { decodeEntities: true }))
  const { resolved } = prepareContentTree(nodes)
  const landmarks = nodes.filter(n => (['main', 'article'].includes(tag(n)) || attrs(n).role === 'main') && ![n, ...parents(n)].some(invisible))
  const root = contentRoot(nodes)
  const visibleText = (node: Node): string => dropped.has(tag(node)) || chrome(node) || 'hidden' in attrs(node) || attrs(node)['aria-hidden'] === 'true'
    ? '' : node.type === 'text' ? node.data : children(node).map(visibleText).join(' ')
  const text = visibleText(root).replace(/\s+/g, ' ').trim()
  const heading = nodes.filter(n => ['title', 'h1'].includes(tag(n))).map(n => DomUtils.textContent(n).trim()).join(' | ')
  if (text.length < 5000 && /(?:^|\|)\s*(?:just a moment[.!…]*|verify (?:that )?you are human|security (?:check|verification)|access denied|attention required[!…]*|人机验证|安全验证)\s*(?:\||$)/i.test(heading)) throw new CrawlError('page_challenge')
  if (text.length < 5000 && /(?:sign in|log in|login|登录)/i.test(heading)
    && nodes.some(n => tag(n) === 'input' && attrs(n).type?.toLowerCase() === 'password')) throw new CrawlError('page_login')
  const placeholder = /^(?:loading(?:\b|[.…])|please wait\b|加载中|正在加载|请稍候)/i.test(text) && text.length < 500
  const contentNodes = walk(root)
  const pending = landmarks.some(n => attrs(n)['aria-busy'] === 'true') || contentNodes.some(n => {
    if ([n, ...parents(n)].some(invisible)) return false
    const a = attrs(n)
    return /^true$/i.test(a['data-loading'] ?? '') || /^(?:loading|skeleton)(?:[-_ ]|$)/i.test(a.class ?? '') && DomUtils.textContent(n).trim().length < 100
  })
  const scripts = nodes.filter(n => tag(n) === 'script' && !/json|ld\+json|plain/i.test(attrs(n).type ?? ''))
  const emptyMount = nodes.some(n => ['app', '__nuxt', '__next', 'root'].includes(attrs(n).id ?? '') && visibleText(n).trim().length < 120)
  const asyncContent = scripts.some(n => /\bfetch\s*\(|XMLHttpRequest/.test(DomUtils.textContent(n)) && /innerHTML|appendChild|replaceChildren|textContent/.test(DomUtils.textContent(n)))
  const expandable = contentNodes.some(n => {
    if (resolved.has(n) || parents(n).some(invisible) || !['button', 'a'].includes(tag(n))) return false
    const a = attrs(n), text = DomUtils.textContent(n).trim()
    // Dropdowns, menu toggles and promotional popovers are not missing prose.
    // An unresolved FAQ/heading disclosure can indicate missing authored content.
    return a['aria-expanded'] === 'false' && !!a['aria-controls'] && a.role !== 'combobox'
      && (/[?？]\s*$/.test(text) || walk(n).some(child => /^h[1-6]$/.test(tag(child))))
  })
  let readable = true
  try { extractWebSourceContent(html, url) } catch (error) {
    if (!(error instanceof CrawlError) || error.code !== 'no_readable_content') throw error
    readable = false
  }
  // An empty interactive app may sit beside a complete static product page.
  // Its presence alone does not make the published body depend on JavaScript.
  return { needsBrowser: pending || placeholder || expandable || asyncContent || !readable || !!scripts.length && emptyMount && text.length < 120, loading: placeholder || pending, asyncContent }
}

export function extractWebSourceContent(html: string, url: string, options: { allowEmpty?: boolean } = {}) {
  const dom = parseDocument(html, { decodeEntities: true }), nodes = walk(dom)
  const { descriptions, ui } = prepareContentTree(nodes)
  const metas = nodes.filter(n => tag(n) === 'meta')
  if (metas.some(n => (attrs(n).name ?? '').toLowerCase() === 'feedlogbot' && /\b(noindex|none)\b/i.test(attrs(n).content ?? ''))) throw new CrawlError('page_noindex')
  const description = metas.find(n => attrs(n).name?.toLowerCase() === 'description')
  // Prefer explicit content landmarks; otherwise retain body content after
  // removing navigation, banners, controls, hidden nodes and active content.
  const root = contentRoot(nodes)
  const titleNode = walk(root).find(n => tag(n) === 'h1' && ![n, ...parents(n)].some(invisible)) ?? nodes.find(n => tag(n) === 'title')
  const title = (titleNode ? DomUtils.textContent(titleNode) : new URL(url).pathname).replace(/\s+/g, ' ').trim().slice(0, 300)
  const emittedDescriptions = new Set<string>()
  function render(node: Node, pre = false): string {
    const name = tag(node), a = attrs(node)
    if (chrome(node) || 'hidden' in a || a['aria-hidden'] === 'true' || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(a.style ?? '')) return ''
    if (ui.has(node)) {
      // A counter or empty-result wrapper can also own an informational
      // tooltip. Strip its runtime text, not the authored billing conditions.
      return walk(node).map(child => {
        const fact = descriptions.get(child)
        if (!fact || emittedDescriptions.has(fact)) return ''
        emittedDescriptions.add(fact)
        return '\n\n' + fact + '\n\n'
      }).join('')
    }
    const description = descriptions.get(node)
    let annotation = ''
    if (description && !emittedDescriptions.has(description)) {
      emittedDescriptions.add(description); annotation = '\n\n' + description + '\n\n'
    }
    if (name === 'button') return annotation
    if (dropped.has(name)) return ''
    if (node.type === 'text') return pre ? node.data : node.data.replace(/\s+/g, ' ')
    const email = protectedEmail(a['data-cfemail'])
    if (email) return email
    if (name === 'table') {
      // Render cells once: a preliminary child walk would consume annotations
      // before the table serializer gets to the actual cell output.
      const rows = walk(node).filter(n => tag(n) === 'tr' && ![n, ...parents(n)].some(invisible)).map(row => children(row).filter(n => ['th', 'td'].includes(tag(n)) && !invisible(n))
        .map(cell => render(cell).trim().replace(/\|/g, '\\|').replace(/\s*\n\s*/g, '<br>')))
      const width = Math.max(0, ...rows.map(row => row.length))
      if (!width) return annotation
      const table = rows.map(row => '| ' + Array.from({ length: width }, (_, i) => row[i] ?? '').join(' | ') + ' |')
      table.splice(1, 0, '| ' + Array(width).fill('---').join(' | ') + ' |')
      return '\n\n' + table.join('\n') + '\n\n'
    }
    const text = children(node).map(n => render(n, pre || name === 'pre')).join('') + annotation
    if (/^h[1-6]$/.test(name)) return `\n\n${'#'.repeat(Number(name[1]))} ${text.trim()}\n\n`
    if (name === 'pre') return `\n\n\`\`\`\n${text.trim()}\n\`\`\`\n\n`
    if (name === 'code' && !pre) return '`' + text + '`'
    if (name === 'a' && a.href && text.trim()) {
      try { const target = normalizeWebSourceUrl(new URL(a.href, url).href); return `[${text.trim()}](${target})` } catch { return text }
    }
    if (name === 'br') return '\n'
    if (name === 'li') return `\n- ${text.trim()}`
    if (['td', 'th'].includes(name)) return text.trim()
    if (name === 'tr') return '\n| ' + text
    if (['p', 'div', 'section', 'blockquote', 'ul', 'ol', 'table'].includes(name)) return '\n\n' + text.trim() + '\n\n'
    return text
  }
  let content = render(root).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  // Retain explicit contact facts from global footers, not their link menus or
  // copyright chrome. No layout/class-name guessing and no model request.
  const contacts = nodes.filter(n => parents(n).some(p => tag(p) === 'footer')
    && ![n, ...parents(n)].some(p => hidden(p) || ['dialog', 'alertdialog'].includes(attrs(p).role ?? '')
      || attrs(p)['aria-modal'] === 'true' || tag(p) !== 'footer' && invisible(p))).flatMap(n => {
    const a = attrs(n)
    if (invisible(n)) return []
    if (tag(n) === 'address') return [readableText(n).replace(/\s+/g, ' ').trim()]
    if (tag(n) !== 'a' || !/^(?:mailto|tel):/i.test(a.href ?? '')) return []
    try { return [decodeURIComponent(new URL(a.href!).pathname).trim()] } catch { return [] }
  }).filter(Boolean)
  for (const contact of new Set(contacts)) if (!content.includes(contact)) content += '\n\n' + contact
  if (content.length < 40 && !options.allowEmpty) throw new CrawlError('no_readable_content')
  if (content.length > 500000) throw new CrawlError('content_too_large')
  const hash = createHash('sha256').update(title + '\n' + content).digest('hex')
  const links = nodes.filter(n => tag(n) === 'a' && attrs(n).href).flatMap(n => {
    try { return [normalizeWebSourceUrl(new URL(attrs(n).href!, url).href)] } catch { return [] }
  })
  const declaredLanguage = attrs(nodes.find(n => tag(n) === 'html') ?? root).lang
  const language = declaredLanguage && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(declaredLanguage) ? declaredLanguage : undefined
  return { title, content, language, description: description ? attrs(description).content?.slice(0, 500) ?? null : null, hash, links: [...new Set(links)] }
}
