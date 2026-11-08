export const toolbarFormats: Record<string, string> = {
  bold: 'bold', italic: 'italic', strikeThrough: 'strike', codeRow: 'code', title: 'heading', link: 'link',
  quote: 'blockquote', unorderedList: 'bulletList', orderedList: 'orderedList', task: 'taskList', code: 'codeBlock',
}
export const toolbarLabels = {
  en: { bold: 'bold', italic: 'italic', strikeThrough: 'strikethrough', title: 'heading', quote: 'blockquote', unorderedList: 'unordered list', orderedList: 'ordered list', task: 'task list', code: 'block-level code', codeRow: 'inline code', link: 'link', image: 'image', table: 'table', revoke: 'undo', next: 'redo', previewOnly: 'preview only', preview: 'preview', save: 'save', fullscreen: 'fullscreen', pageFullscreen: 'page fullscreen', upload: 'Upload Images', crop: 'Crop And Upload', url: 'Image link', address: 'Enter a link...', description: 'Description', addressLabel: 'URL', paragraph: 'Paragraph', editLink: 'Edit link', unlink: 'Remove link', openLink: 'Open link', linkActions: 'Link actions', ok: 'OK', cancel: 'Cancel', count: 'characters' },
  zh: { bold: '加粗', italic: '斜体', strikeThrough: '删除线', title: '标题', quote: '引用', unorderedList: '无序列表', orderedList: '有序列表', task: '任务列表', code: '代码块', codeRow: '行内代码', link: '链接', image: '图片', table: '表格', revoke: '撤销', next: '重做', previewOnly: '预览', preview: '预览', save: '保存', fullscreen: '全屏', pageFullscreen: '页面全屏', upload: '上传图片', crop: '裁剪并上传', url: '图片链接', address: '请输入链接...', description: '描述', addressLabel: '地址', paragraph: '正文', editLink: '编辑链接', unlink: '取消链接', openLink: '打开链接', linkActions: '链接操作', ok: '确定', cancel: '取消', count: '字符' },
}
export type UploadImage = string | { url: string, alt?: string, title?: string }
export type UploadImgCallBack = (urls: UploadImage[]) => void
export type SourceInsertion = { targetValue: string, select?: boolean, deviationStart?: number, deviationEnd?: number }

// External clipboard HTML often contains layout-only paragraphs and emoji images.
// Preserve semantic formatting; plain text remains authoritative for ordinary prose.
export function normalizeMarkdownClipboard(html: string): { html: string, preferText: boolean } {
  const body = new DOMParser().parseFromString(html, 'text/html').body
  if (body.hasAttribute('data-pm-slice') || body.querySelector('[data-pm-slice]')) return { html, preferText: false }
  for (const image of body.querySelectorAll('img')) {
    const alt = image.alt.trim()
    const emojiText = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(alt)
      && alt.replace(/\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\u200d|\ufe0e|\ufe0f|[0-9#*]|\u20e3/gu, '') === ''
    const emojiImage = /(?:^|\s)(?:emoji|twemoji|emojione)(?:\s|$)/i.test(image.className)
      || /twemoji|notoemoji|emojione|emoji-datasource|\/emojis?\//i.test(image.getAttribute('src') ?? '')
      || image.hasAttribute('data-emoji')
    if (emojiText && emojiImage) image.replaceWith(body.ownerDocument.createTextNode(alt))
  }
  for (const block of Array.from(body.querySelectorAll('p, div')).reverse()) {
    // Empty table cells/list items and whitespace inside code have meaning.
    if (block.closest('pre, code, td, th, li') || block.textContent?.trim()) continue
    if (!block.querySelector('img, svg, video, iframe, hr, input, table') && block.querySelectorAll('br').length <= 1) block.remove()
  }
  const structure = body.querySelector('h1,h2,h3,h4,h5,h6,ul,ol,li,blockquote,pre,code,table,hr,img,figure')
  const styled = Array.from(body.querySelectorAll('b,strong,em,i,s,del,[style]')).some(element => {
    const style = (element as HTMLElement).style
    if (['B', 'STRONG'].includes(element.tagName) && !['normal', '400'].includes(style.fontWeight)) return true
    return ['EM', 'I', 'S', 'DEL'].includes(element.tagName)
      || /bold|[6-9]00/.test(style.fontWeight) || style.fontStyle === 'italic' || /line-through/.test(style.textDecoration)
  })
  const namedLink = Array.from(body.querySelectorAll('a[href]')).some(link => link.textContent?.trim() !== link.getAttribute('href')?.trim())
  return { html: body.innerHTML, preferText: !structure && !styled && !namedLink }
}

// Keep toolbar controls mounted while moving them into responsive overflow.
export function createMarkdownToolbarOverflow(root: HTMLElement, label: () => string, closeMenus: () => void) {
  const toolbar = root.querySelector<HTMLElement>('.md-editor-toolbar')!
  const tools = toolbar.querySelector<HTMLElement>('.md-editor-toolbar-left')!
  const right = toolbar.querySelector<HTMLElement>('.md-editor-toolbar-right')!
  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'fdl-toolbar-overflow-trigger'
  trigger.setAttribute('aria-expanded', 'false')
  const previousId = tools.id
  tools.id ||= `${root.id}-overflow-tools`
  trigger.setAttribute('aria-controls', tools.id)
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '18'); svg.setAttribute('height', '18')
  svg.setAttribute('aria-hidden', 'true')
  for (const y of [5, 12, 19]) {
    const circle = document.createElementNS(svg.namespaceURI, 'circle')
    circle.setAttribute('cx', '12'); circle.setAttribute('cy', String(y))
    circle.setAttribute('r', '1.6'); circle.setAttribute('fill', 'currentColor')
    svg.append(circle)
  }
  trigger.append(svg)
  toolbar.insertBefore(trigger, tools)
  let collapsed = false
  let open = false
  let frame = 0
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  const cancelClose = () => { clearTimeout(closeTimer); closeTimer = undefined }
  const setOpen = (value: boolean) => {
    cancelClose()
    open = collapsed && value
    root.toggleAttribute('data-toolbar-overflow-open', open)
    trigger.setAttribute('aria-expanded', String(open))
    tools.inert = collapsed && !open
    if (!open) {
      closeMenus()
    }
  }
  const contains = (target: EventTarget | null) => target instanceof Node && (trigger.contains(target) || tools.contains(target) || (target instanceof Element && !!target.closest(`[data-editor-owner="${root.id}"]`)))
  const menuOpen = () => !!document.querySelector(`[data-editor-owner="${root.id}"][data-state="open"]`)
  const enter = (event: PointerEvent) => { if (collapsed && event.pointerType !== 'touch') setOpen(true) }
  const scheduleClose = () => {
    if (closeTimer) return
    closeTimer = setTimeout(() => {
      closeTimer = undefined
      if (!contains(document.activeElement) && !menuOpen()) setOpen(false)
    }, 150)
  }
  const leave = (event: PointerEvent) => { if (collapsed && open && !contains(event.relatedTarget)) scheduleClose() }
  const pointermove = (event: PointerEvent) => {
    if (!collapsed || !open) return
    if (contains(event.target)) cancelClose()
    else scheduleClose()
  }
  const protectSelection = (event: MouseEvent) => event.preventDefault()
  const protectToolsSelection = (event: MouseEvent) => {
    if (collapsed && event.target instanceof Element && !event.target.closest('input, textarea, select, [contenteditable="true"]')) event.preventDefault()
  }
  const click = (event: MouseEvent) => {
    // Mouse hover already opens the tools; clicking must preserve the editor selection.
    if (event.detail === 0) setOpen(!open)
    else setOpen(true)
  }
  const visibleButtons = () => Array.from(tools.querySelectorAll<HTMLButtonElement>('button:not([disabled])'))
    .filter(button => button.getBoundingClientRect().width > 0 && getComputedStyle(button).visibility !== 'hidden')
  const keydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.focus()
    } else if (event.target === trigger && ['ArrowDown', 'Enter', ' '].includes(event.key)) {
      event.preventDefault(); setOpen(true); visibleButtons()[0]?.focus()
    } else if (open && event.target instanceof HTMLElement && ['ArrowRight', 'ArrowLeft'].includes(event.key)) {
      const buttons = visibleButtons(), index = buttons.indexOf(event.target as HTMLButtonElement)
      if (index >= 0) {
        event.preventDefault()
        buttons[(index + (event.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length]?.focus()
      }
    }
  }
  const outside = (event: PointerEvent) => { if (open && !contains(event.target)) setOpen(false) }
  const focusout = () => {
    queueMicrotask(() => { if (collapsed && open && !contains(document.activeElement) && !tools.matches(':hover') && !trigger.matches(':hover') && !menuOpen()) setOpen(false) })
  }
  const measure = () => {
    frame = 0
    trigger.setAttribute('aria-label', label()); trigger.title = label()
    tools.setAttribute('role', 'toolbar'); tools.setAttribute('aria-label', label())
    const items = Array.from(tools.children).filter((item): item is HTMLElement => {
      if (!(item instanceof HTMLElement)) return false
      const style = getComputedStyle(item)
      return style.position !== 'absolute' && style.display !== 'none'
    })
    const itemWidth = items.reduce((width, item) => {
      const style = getComputedStyle(item)
      return width + item.getBoundingClientRect().width + (parseFloat(style.marginLeft) || 0) + (parseFloat(style.marginRight) || 0)
    }, 0)
    const toolsWidth = itemWidth + Math.max(0, items.length - 1) * (parseFloat(getComputedStyle(root).getPropertyValue('--fdl-toolbar-gap')) || 2)
    const available = toolbar.clientWidth - right.getBoundingClientRect().width - (parseFloat(getComputedStyle(toolbar).columnGap) || 0)
    const next = items.length > 0 && toolsWidth > available + 1
    if (next !== collapsed) {
      collapsed = next
      root.toggleAttribute('data-toolbar-collapsed', collapsed)
      setOpen(false)
    }
  }
  const refresh = () => { if (!frame) frame = requestAnimationFrame(measure) }
  const resize = new ResizeObserver(refresh)
  resize.observe(toolbar); resize.observe(right); resize.observe(tools)
  trigger.addEventListener('pointerenter', enter)
  trigger.addEventListener('pointerleave', leave)
  tools.addEventListener('pointerenter', enter)
  tools.addEventListener('pointerleave', leave)
  trigger.addEventListener('mousedown', protectSelection)
  tools.addEventListener('mousedown', protectToolsSelection)
  trigger.addEventListener('click', click)
  trigger.addEventListener('keydown', keydown)
  tools.addEventListener('keydown', keydown)
  tools.addEventListener('focusout', focusout)
  trigger.addEventListener('focusout', focusout)
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('pointermove', pointermove, true)
  measure()
  return {
    toolbar, refresh,
    close: () => setOpen(false),
    destroy() {
      cancelClose(); cancelAnimationFrame(frame); resize.disconnect()
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('pointermove', pointermove, true)
      tools.removeEventListener('pointerenter', enter); tools.removeEventListener('pointerleave', leave)
      tools.removeEventListener('mousedown', protectToolsSelection)
      tools.removeEventListener('keydown', keydown); tools.removeEventListener('focusout', focusout)
      trigger.remove()
      tools.inert = false
      tools.id = previousId
      tools.removeAttribute('role'); tools.removeAttribute('aria-label')
      root.removeAttribute('data-toolbar-collapsed'); root.removeAttribute('data-toolbar-overflow-open')
    },
  }
}

