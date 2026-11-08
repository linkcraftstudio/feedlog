import type { NodeViewRenderer } from '@tiptap/core'

const plainLanguages = new Set(['', 'text', 'txt', 'plain', 'plaintext'])
function isPlainLanguage(value: string) { return plainLanguages.has(value.toLowerCase()) }

const languageNames: Record<string, string> = {
  javascript: 'JavaScript', typescript: 'TypeScript', jsx: 'JSX', tsx: 'TSX', json: 'JSON',
  html: 'HTML', css: 'CSS', scss: 'SCSS', vue: 'Vue', bash: 'Bash', shell: 'Shell',
  python: 'Python', sql: 'SQL', yaml: 'YAML', toml: 'TOML', xml: 'XML', markdown: 'Markdown',
  go: 'Go', rust: 'Rust', java: 'Java', kotlin: 'Kotlin', c: 'C', cpp: 'C++', csharp: 'C#',
  ruby: 'Ruby', php: 'PHP', swift: 'Swift', dockerfile: 'Dockerfile', diff: 'Diff',
}
const languageAliases: Record<string, string> = { js: 'javascript', ts: 'typescript', py: 'python', sh: 'shell', yml: 'yaml', md: 'markdown', 'c++': 'cpp', 'c#': 'csharp' }
export function codeLanguageName(value: string, plainText: string) {
  const key = value.toLowerCase()
  return isPlainLanguage(key) ? plainText : languageNames[languageAliases[key] ?? key] ?? value
}
export type CodeLanguageControl = (host: HTMLElement, state: {
  value: string, label: string, disabled: boolean, options: { value: string, label: string }[],
  onChange: (value: string) => void,
} | null) => void

// The editable node and public renderer share code-frame classes and styling.
export function createMarkdownCodeView(renderLanguage: CodeLanguageControl): NodeViewRenderer {
  return ({ node, editor, getPos }) => {
    let current = node
    const dom = document.createElement('div')
    dom.className = 'md-editor-code fdl-code-view'
    const head = document.createElement('div')
    head.className = 'md-editor-code-head'
    head.contentEditable = 'false'
    const flags = document.createElement('div')
    flags.className = 'md-editor-code-flag'
    for (let index = 0; index < 3; index++) flags.append(document.createElement('span'))
    const actions = document.createElement('div')
    actions.className = 'fdl-code-actions'
    const language = document.createElement('div')
    const onChange = (value: string) => {
      if (!editor.isEditable) return
      const pos = getPos()
      if (typeof pos !== 'number') return
      editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, language: value === 'plaintext' ? null : value }))
    }
    const editorAttributes = editor.options.editorProps.attributes
    const collapse = document.createElement('button')
    collapse.type = 'button'
    collapse.className = 'fdl-code-collapse'
    const chevron = document.createElement('span')
    chevron.className = 'fdl-code-chevron'
    chevron.setAttribute('aria-hidden', 'true')
    collapse.append(chevron)
    collapse.setAttribute('aria-label', typeof editorAttributes === 'object' ? editorAttributes['data-code-collapse'] || 'Collapse or expand code' : 'Collapse or expand code')
    collapse.setAttribute('aria-expanded', 'true')
    collapse.addEventListener('mousedown', event => event.preventDefault())
    collapse.addEventListener('click', () => {
      const collapsed = dom.classList.toggle('fdl-code-collapsed')
      collapse.setAttribute('aria-expanded', String(!collapsed))
    })
    actions.append(language, collapse)
    head.append(flags, actions)
    const body = document.createElement('div')
    body.className = 'fdl-code-body'
    const numbers = document.createElement('div')
    numbers.className = 'fdl-code-lines'
    numbers.contentEditable = 'false'
    numbers.setAttribute('aria-hidden', 'true')
    const pre = document.createElement('pre')
    const code = document.createElement('code')
    pre.append(code)
    body.append(numbers, pre)
    dom.append(head, body)
    const refresh = () => {
      const attributes = editor.options.editorProps.attributes
      const labels = typeof attributes === 'object' ? attributes : {}
      collapse.setAttribute('aria-label', labels['data-code-collapse'] || 'Collapse or expand code')
      const storedLanguage = String(current.attrs.language || '')
      const key = storedLanguage.toLowerCase()
      const value = isPlainLanguage(key) ? 'plaintext' : languageAliases[key] ?? key
      const plainText = labels['data-code-plain-text'] || 'Plain text'
      const options = Object.entries(languageNames).map(([value, label]) => ({ value, label }))
      if (value !== 'plaintext' && !options.some(option => option.value === value)) options.push({ value, label: storedLanguage })
      options.sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }))
      options.unshift({ value: 'plaintext', label: plainText })
      renderLanguage(language, { value, label: labels['data-code-language'] || 'Code language', disabled: !editor.isEditable, options, onChange })
      numbers.textContent = current.textContent.split('\n').map((_, index) => index + 1).join('\n')
    }
    refresh()
    editor.on('transaction', refresh)
    return {
      dom, contentDOM: code,
      update(next) { if (next.type !== current.type) return false; current = next; refresh(); return true },
      ignoreMutation(mutation) { return mutation.type !== 'selection' && !code.contains(mutation.target) && mutation.target !== code },
      stopEvent(event) { return head.contains(event.target as Node) },
      destroy() { editor.off('transaction', refresh); renderLanguage(language, null) },
    }
  }
}

// Server-safe markup: code and language remain escaped literal text.
export function markdownCodeBlock(text: string, language: string, labels: { collapse: string, plainText: string, copy?: string }) {
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  const numbers = text.split('\n').map((_, index) => index + 1).join('\n')
  return `<div class="md-editor-code fdl-code-view"><div class="md-editor-code-head"><div class="md-editor-code-flag" aria-hidden="true"><span></span><span></span><span></span></div><div class="fdl-code-actions"><span class="fdl-code-language-label">${escape(codeLanguageName(language, labels.plainText))}</span><button type="button" class="fdl-code-copy" aria-live="polite">${escape(labels.copy ?? 'Copy')}</button><button type="button" class="fdl-code-collapse" aria-label="${escape(labels.collapse)}" aria-expanded="true"><span class="fdl-code-chevron" aria-hidden="true"></span></button></div></div><div class="fdl-code-body"><div class="fdl-code-lines" aria-hidden="true">${numbers}</div><pre><code>${escape(text)}</code></pre></div></div>\n`
}
