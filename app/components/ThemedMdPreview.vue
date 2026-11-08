<script setup lang="ts">
import { renderMarkdown } from '~/lib/markdown-render'
import '~/assets/css/markdown-content.css'
const props = withDefaults(defineProps<{
  modelValue?: string, editorId?: string, language?: string,
  sanitize?: (html: string) => string,
  mdHeadingId?: (heading: { text: string, level: number, index: number }) => string,
}>(), { modelValue: '', editorId: undefined, language: undefined, sanitize: undefined, mdHeadingId: undefined })
const { t } = useI18n()
const label = (key: string) => t(`markdownEditor.${key}`, {}, props.language ? { locale: props.language === 'zh-CN' ? 'zh' : 'en' } : {})
const html = computed(() => renderMarkdown(props.modelValue, props.mdHeadingId, props.sanitize, { collapse: label('collapseCode'), plainText: label('plainText'), copy: label('copyCode') }))
const feedbackTimers = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>()
let disposed = false
function fallbackCopy(text: string, button: HTMLButtonElement) {
  const active = document.activeElement as HTMLElement | null
  const selection = window.getSelection()
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : []
  const input = document.createElement('textarea')
  input.value = text
  input.readOnly = true
  input.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none'
  ;(button.closest('.fdl-markdown-preview') ?? document.body).append(input)
  try {
    input.focus({ preventScroll: true }); input.select()
    if (!document.execCommand('copy')) throw new Error('Copy unavailable')
  } finally {
    input.remove()
    if (selection) {
      selection.removeAllRanges()
      for (const range of ranges) if (range.commonAncestorContainer.isConnected) selection.addRange(range)
    }
    if (active?.isConnected) active.focus({ preventScroll: true })
  }
}
async function handleCodeAction(event: MouseEvent) {
  const button = (event.target as Element).closest<HTMLButtonElement>('button.fdl-code-collapse, button.fdl-code-copy')
  const block = button?.closest('.fdl-code-view')
  if (!block || !button) return
  if (button.classList.contains('fdl-code-collapse')) {
    button.setAttribute('aria-expanded', String(!block.classList.toggle('fdl-code-collapsed')))
    return
  }
  if (button.getAttribute('aria-busy') === 'true') return
  const text = block.querySelector('pre code')?.textContent ?? ''
  let copied = false
  button.setAttribute('aria-busy', 'true')
  try {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable')
      await navigator.clipboard.writeText(text)
    } catch { fallbackCopy(text, button) }
    copied = true
  } catch { /* Keep the code selectable if copying is unavailable. */ }
  if (disposed || !button.isConnected) return
  button.removeAttribute('aria-busy')
  button.textContent = label(copied ? 'copiedCode' : 'copyCodeFailed')
  clearTimeout(feedbackTimers.get(button))
  feedbackTimers.set(button, setTimeout(() => {
    if (button.isConnected) button.textContent = label('copyCode')
    feedbackTimers.delete(button)
  }, 2000))
}
onBeforeUnmount(() => { disposed = true; for (const timer of feedbackTimers.values()) clearTimeout(timer); feedbackTimers.clear() })
</script>
<template>
  <div :id="editorId" class="fdl-markdown-preview" @click="handleCodeAction">
    <div class="md-editor-preview-wrapper">
      <!-- HTML passes through the shared server/client sanitizer. -->
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div class="md-editor-preview default-theme" v-html="html" />
    </div>
  </div>
</template>
