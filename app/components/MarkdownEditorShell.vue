<script setup lang="ts">
import { EditorState, Compartment } from '@codemirror/state'
import { EditorView, keymap, placeholder as sourcePlaceholder } from '@codemirror/view'
import { history, historyKeymap, defaultKeymap, undo, redo } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { Check, Bold, Italic, Strikethrough, Heading, List, ListOrdered, ListTodo, Link, Image, Code, SquareCode, Table, Quote, Undo, Redo, Eye, Save, Maximize } from 'lucide-vue-next'
import { toolbarFormats, toolbarLabels, type SourceInsertion } from '~/lib/markdown-editor-ui'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem } from './ui/dropdown-menu'
import MarkdownAddressDialog from './MarkdownAddressDialog.vue'
import ThemedMdPreview from './ThemedMdPreview.vue'
import MarkdownImageCrop from './MarkdownImageCrop.vue'
import '~/assets/css/markdown-editor.css'
const props = withDefaults(defineProps<{
  modelValue: string, structured: boolean, language?: string, theme?: string, placeholder?: string,
  toolbars?: readonly (string | number)[], footers?: readonly (string | number)[],
  headingLevel?: number, activeFormats?: readonly string[], readOnly?: boolean, disabled?: boolean, maxLength?: number, sanitize?: (html: string) => string,
}>(), { language: 'en-US', theme: 'light', placeholder: '', toolbars: () => [], footers: () => ['markdownTotal'], maxLength: undefined, sanitize: undefined, activeFormats: () => [], headingLevel: 0 })
const emit = defineEmits<{
  'update:modelValue': [value: string], command: [name: string, value?: number],
  onSave: [value: string, html: Promise<string>], onFocus: [event: FocusEvent], onBlur: [event: FocusEvent],
  uploadImages: [files: File[]], restoreFocus: [], modeChange: [mode: 'structured' | 'source'],
}>()
const { t } = useI18n()
const modeLabel = (key: string) => t(`markdownEditor.${key}`, {}, { locale: props.language === 'zh-CN' ? 'zh' : 'en' })
function updateMode(value: unknown) { if (value === 'structured' || value === 'source') { previewOnly.value = false; emit('modeChange', value) } }
const shellId = useId()
const root = ref<HTMLElement>()
const sourceMount = ref<HTMLElement>()
const fileInput = ref<HTMLInputElement>()
const previewOnly = ref(false)
const cropOpen = ref(false)
function chooseImage(crop = false) { menu.value = undefined; if (crop) cropOpen.value = true; else fileInput.value?.click() }
const menu = ref<string>()
const fullscreen = ref(false)
const tableSize = ref({ rows: 3, cols: 3 })
const isMenu = (item: string | number) => ['title', 'image', 'table'].includes(String(item))
let menuKeyboard = false
let hoverDismiss = false
let menuEscapeTarget: string | undefined
function keyboardMenu() { menuKeyboard = true }
function pointerMenu(event: PointerEvent) {
  menuKeyboard = false
  if (!(event.currentTarget as HTMLElement).contains(document.activeElement)) event.preventDefault()
}
function menuOpenFocus(event: Event) { if (!menuKeyboard) event.preventDefault() }
let keepMenuOnClick = false
let menuFrame = 0
function cancelMenuClose() { cancelAnimationFrame(menuFrame); menuFrame = 0 }
function closeHoverMenu() { hoverDismiss = true; menuKeyboard = false; menu.value = undefined }
function openMenu(item: string | number) {
  cancelMenuClose()
  if (!isMenu(item) || locked.value || previewOnly.value) { if (menu.value) closeHoverMenu(); return }
  if (menu.value !== item) { menuKeyboard = false; hoverDismiss = false; menuEscapeTarget = undefined }
  menu.value = String(item)
}
function leaveMenu() {
  cancelMenuClose()
  // Let the pointer enter the adjacent portalled menu before checking its position.
  menuFrame = requestAnimationFrame(() => {
    menuFrame = 0
    if (!menu.value) return
    const popup = document.querySelector(`[data-editor-owner="${shellId}"][data-state="open"]`)
    const trigger = root.value?.querySelector(`[data-command="${menu.value}"]`)
    if (!popup?.matches(':hover') && !trigger?.matches(':hover') && !(menuKeyboard && popup?.contains(document.activeElement))) closeHoverMenu()
  })
}
function protectMenuClick(event: MouseEvent, item: string | number) { keepMenuOnClick = event.detail > 0 && isMenu(item) && menu.value === item && !!(event.target as Element).closest('.md-editor-toolbar-item') }
function setMenu(item: string | number, open: boolean) {
  // A previous menu's close event must not dismiss the menu just entered.
  if (!open && menu.value !== item) return
  if (!open && keepMenuOnClick) { keepMenuOnClick = false; return }
  cancelMenuClose()
  menu.value = open ? String(item) : undefined
}
function menuEscape(item: string | number) {
  cancelMenuClose(); menuEscapeTarget = String(item); hoverDismiss = false
}
function menuFocus(event: Event, item: string | number) {
  event.preventDefault()
  if (menu.value) return
  if (menuEscapeTarget === String(item)) {
    menuEscapeTarget = undefined
    root.value?.querySelector<HTMLButtonElement>(`[data-command="${item}"]`)?.focus()
  } else if (hoverDismiss) {
    hoverDismiss = false
    if (!root.value?.querySelector('.fdl-editor-body')?.contains(document.activeElement)) emit('restoreFocus')
  }
}
function gridKey(event: KeyboardEvent, rows: number, cols: number) {
  const offsets: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
  const offset = offsets[event.key]
  if (!offset) return
  event.preventDefault(); event.stopPropagation()
  const row = Math.max(1, Math.min(6, rows + offset[0])), col = Math.max(1, Math.min(6, cols + offset[1]))
  const grid = (event.target as HTMLElement).closest('.fdl-table-picker')
  grid?.querySelector<HTMLButtonElement>(`[data-row="${row}"][data-col="${col}"]`)?.focus()
  tableSize.value = { rows: row, cols: col }
}
function escapeFullscreen(event: KeyboardEvent) { if (event.key === 'Escape' && !event.defaultPrevented && fullscreen.value && !menu.value && !addressKind.value && !cropOpen.value) { fullscreen.value = false; emit('restoreFocus') } }
const addressKind = ref<'link' | 'image'>()
const address = ref('')
const description = ref('')
const labels = computed(() => toolbarLabels[props.language === 'zh-CN' ? 'zh' : 'en'])
const locked = computed(() => props.disabled || props.readOnly)
const divider = computed(() => props.toolbars.indexOf('='))
const leftTools = computed(() => props.toolbars.slice(0, divider.value < 0 ? props.toolbars.length : divider.value).filter(item => typeof item === 'string' && item !== '-'))
const icons: Record<string, unknown> = { bold: Bold, italic: Italic, strikeThrough: Strikethrough, title: Heading, unorderedList: List, orderedList: ListOrdered, task: ListTodo, link: Link, image: Image, code: SquareCode, codeRow: Code, table: Table, quote: Quote, revoke: Undo, next: Redo, previewOnly: Eye, preview: Eye, save: Save, fullscreen: Maximize, pageFullscreen: Maximize }
const headingLabel = (level: number) => props.language === 'zh-CN' ? `${['一', '二', '三', '四', '五', '六'][level - 1]}级标题` : `Heading ${level}`
const label = (name: string) => labels.value[name as keyof typeof labels.value] ?? name
const editable = new Compartment(), hint = new Compartment(), sourceHistory = new Compartment()
let view: EditorView | undefined
let syncing = false
function insert(recipe: (selection: string) => SourceInsertion) {
  if (!view || locked.value) return
  const { from, to } = view.state.selection.main
  const result = recipe(view.state.sliceDoc(from, to))
  const anchor = from + (result.deviationStart ?? (result.select ? 0 : result.targetValue.length))
  const head = from + result.targetValue.length + (result.deviationEnd ?? 0)
  view.dispatch({ changes: { from, to, insert: result.targetValue }, selection: { anchor, head: result.select ? head : anchor }, scrollIntoView: true, userEvent: 'input' })
  view.focus()
}
function wrap(before: string, after = before) {
  insert(text => ({ targetValue: before + text + after, select: true, deviationStart: before.length, deviationEnd: -after.length }))
}
function execute(name: string, value?: number) {
  menu.value = undefined
  if (name === 'previewOnly' || name === 'preview') { previewOnly.value = !previewOnly.value; if (!previewOnly.value) nextTick(() => emit('restoreFocus')); return }
  if (name === 'save') { triggerSave(); return }
  if (name === 'fullscreen' || name === 'pageFullscreen') { fullscreen.value = !fullscreen.value; return }
  if (locked.value || previewOnly.value) return
  if (props.structured) { emit('command', name, value); return }
  if (name === 'link' || name === 'image') {
    addressKind.value = name; address.value = ''; description.value = view?.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to) ?? ''; return
  }
  if (name === 'revoke') { if (view) { undo(view); view.focus() }; return }
  if (name === 'next') { if (view) { redo(view); view.focus() }; return }
  if (name === 'code' || name === 'codeRow') {
    const text = view?.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to) ?? ''
    const marker = '`'.repeat(Math.max(name === 'code' ? 3 : 1, ...Array.from(text.matchAll(/`+/g), match => match[0].length + 1)))
    if (name === 'code') {
      insertBlock(marker + '\n', text, '\n' + marker)
    } else {
      const padding = /^`|`$/.test(text) ? ' ' : ''
      wrap(marker + padding, padding + marker)
    }
    return
  }
  const pairs: Record<string, [string, string?]> = { bold: ['**'], italic: ['*'], strikeThrough: ['~~'] }
  if (pairs[name]) { wrap(...pairs[name]); return }
  if (name === 'table') {
    const cols = value ?? 3, rows = tableRows.value
    const row = '| ' + Array(cols).fill('').join(' | ') + ' |'
    const text = '\n' + [row, '| ' + Array(cols).fill('---').join(' | ') + ' |', ...Array(rows - 1).fill(row)].join('\n') + '\n'
    insert(() => ({ targetValue: text, select: true, deviationStart: 3, deviationEnd: 3 - text.length })); return
  }
  const prefixes: Record<string, string> = { title: '#'.repeat(value ?? 2) + ' ', unorderedList: '- ', orderedList: '1. ', task: '- [ ] ', quote: '> ' }
  if (prefixes[name] || name === 'paragraph') {
    if (!view) return
    const selection = view.state.selection.main
    const from = view.state.doc.lineAt(selection.from).from
    const to = view.state.doc.lineAt(selection.to > selection.from && view.state.doc.lineAt(selection.to).from === selection.to ? selection.to - 1 : selection.to).to
    const text = view.state.sliceDoc(from, to).split('\n').map(line => name === 'paragraph' ? line.replace(/^#{1,6}\s+/, '') : prefixes[name] + (name === 'title' ? line.replace(/^#{1,6}\s+/, '') : line)).join('\n')
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, scrollIntoView: true, userEvent: 'input' })
    view.focus()
  }
}
function insertBlock(before: string, text: string, after: string) {
  if (!view) return
  const selection = view.state.selection.main
  const prefix = view.state.sliceDoc(0, selection.from), suffix = view.state.sliceDoc(selection.to)
  const leading = !prefix || prefix.endsWith('\n\n') ? '' : prefix.endsWith('\n') ? '\n' : '\n\n'
  const trailing = !suffix || suffix.startsWith('\n\n') ? '' : suffix.startsWith('\n') ? '\n' : '\n\n'
  insert(() => ({ targetValue: leading + before + text + after + trailing, select: true, deviationStart: leading.length + before.length, deviationEnd: -after.length - trailing.length }))
}
const tableRows = ref(3)
function table(rows: number, cols: number) { tableRows.value = rows; if (props.structured) { menu.value = undefined; emit('command', 'table', rows * 100 + cols) } else execute('table', cols) }
function cancelAddress() { addressKind.value = undefined }
function cancelCrop() { cropOpen.value = false }
function confirmAddress() {
  if (!address.value.trim() || locked.value) return
  const destination = address.value.trim().replace(/[<>\n]/g, '')
  const text = description.value.replace(/[[\]\\]/g, '\\$&')
  insert(() => ({ targetValue: `${addressKind.value === 'image' ? '!' : ''}[${text}](<${destination}>)` }))
  addressKind.value = undefined
}
function uploadFiles(event: Event) {
  const files = Array.from((event.target as HTMLInputElement).files ?? [])
  sendFiles(files)
  ;(event.target as HTMLInputElement).value = ''
  menu.value = undefined
}
function applyCrop(file: File) { cropOpen.value = false; sendFiles([file]) }
function sendFiles(files: File[]) { if (!locked.value && files.length) emit('uploadImages', files) }
function triggerSave() { emit('onSave', props.modelValue, import('~/lib/markdown-render').then(module => module.renderMarkdown(props.modelValue, undefined, props.sanitize))) }
function resetHistory() { view?.dispatch({ effects: sourceHistory.reconfigure(history()) }) }
function dismissDialogs() { addressKind.value = undefined; cropOpen.value = false; menu.value = undefined }
watch(locked, value => { if (value) dismissDialogs() })
onMounted(() => {
  view = new EditorView({ parent: sourceMount.value!, state: EditorState.create({ doc: props.modelValue, extensions: [
    markdown(), syntaxHighlighting(defaultHighlightStyle), EditorView.lineWrapping, sourceHistory.of(history()), keymap.of([{ key: 'Mod-s', run: () => { triggerSave(); return true } }, ...defaultKeymap, ...historyKeymap]),
    editable.of([EditorState.readOnly.of(!!locked.value), EditorView.editable.of(!locked.value)]), hint.of(sourcePlaceholder(props.placeholder)),
    EditorView.theme({ '&': { height: '100%', color: 'var(--foreground)', backgroundColor: 'transparent' }, '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--fdl-editor-font-family)', fontSize: '14px', lineHeight: '1.7' }, '.cm-content': { padding: '12px 16px', minHeight: '100%' }, '.cm-focused': { outline: 'none' }, '&.cm-focused': { outline: 'none' }, '.cm-cursor': { borderLeftColor: 'var(--foreground)' }, '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { background: 'color-mix(in srgb, var(--foreground) 18%, transparent)' } }),
    EditorView.updateListener.of(update => { if (update.docChanged && !syncing) emit('update:modelValue', update.state.doc.toString()) }),
    EditorView.domEventHandlers({ focus: event => { emit('onFocus', event); return false }, blur: event => { emit('onBlur', event); return false } }),
  ] }) })
  document.addEventListener('keydown', escapeFullscreen)
})
watch(() => props.modelValue, value => {
  if (view && value !== view.state.doc.toString()) { syncing = true; view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }); syncing = false }
})
watch(locked, value => view?.dispatch({ effects: editable.reconfigure([EditorState.readOnly.of(!!value), EditorView.editable.of(!value)]) }))
watch(() => props.placeholder, value => view?.dispatch({ effects: hint.reconfigure(sourcePlaceholder(value)) }))
watch(() => props.structured, () => { previewOnly.value = false; menu.value = undefined; nextTick(() => view?.requestMeasure()) })
onBeforeUnmount(() => { view?.destroy(); cancelMenuClose(); document.removeEventListener('keydown', escapeFullscreen) })
defineExpose({ closeToolbarMenu: () => { menu.value = undefined }, dismissDialogs, getEditorView: () => view, insert, resetHistory, triggerSave, focus: () => view?.focus(), getSelectedText: () => view?.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to), togglePreviewOnly: (value?: boolean) => { previewOnly.value = value ?? !previewOnly.value } })
</script>
<template>
  <div :id="shellId" ref="root" class="md-editor fdl-markdown-editor" :class="{ 'md-editor-dark': theme === 'dark', 'fdl-structured-shell': structured, 'fdl-editor-fullscreen': fullscreen }">
    <div v-if="toolbars.length" class="md-editor-toolbar-wrapper">
      <div class="md-editor-toolbar" role="toolbar">
        <div class="md-editor-toolbar-left">
          <DropdownMenu v-for="(item, index) in leftTools" :key="index" :open="menu === item" :modal="false" @update:open="value => setMenu(item, value)">
            <div class="fdl-tool" @click.capture="protectMenuClick($event, item)" @pointerenter="openMenu(item)" @pointerleave="leaveMenu" @keydown.capture="keyboardMenu">
              <component :is="isMenu(item) ? DropdownMenuTrigger : 'button'" type="button" class="md-editor-toolbar-item" :data-command="item" :class="{ 'fdl-format-active': structured && activeFormats.includes(String(item)) }" :aria-pressed="['previewOnly', 'preview'].includes(String(item)) ? previewOnly : ['fullscreen', 'pageFullscreen'].includes(String(item)) ? fullscreen : structured && toolbarFormats[String(item)] ? activeFormats.includes(String(item)) : undefined" :aria-label="label(String(item))" :title="item === 'title' && structured && headingLevel ? `${label('title')} ${headingLevel}` : label(String(item))" :disabled="(locked || previewOnly) && !['previewOnly', 'preview', 'fullscreen', 'pageFullscreen', ...(previewOnly && !locked ? ['save'] : [])].includes(String(item))" @mousedown.prevent @click="!isMenu(item) && execute(String(item))">
                <span v-if="item === 'title' && structured && headingLevel" class="fdl-heading-level" aria-hidden="true">H{{ headingLevel }}</span><component :is="icons[String(item)]" v-else :size="16" aria-hidden="true" />
              </component>
              <DropdownMenuContent v-if="isMenu(item)" class="fdl-tool-menu" :side-offset="0" :data-editor-owner="shellId" align="start" @keydown.capture="keyboardMenu" @pointermove.capture="pointerMenu" @pointerleave.capture="pointerMenu" @pointerenter="openMenu(item)" @pointerleave="leaveMenu" @open-auto-focus="menuOpenFocus" @escape-key-down="menuEscape(item)" @close-auto-focus="event => menuFocus(event, item)">
                <template v-if="item === 'title'">
                  <DropdownMenuItem class="pr-8" @select="execute('paragraph')">{{ labels.paragraph }}</DropdownMenuItem>
                  <DropdownMenuRadioGroup :model-value="structured && headingLevel ? String(headingLevel) : undefined"><DropdownMenuRadioItem v-for="level in 6" :key="level" :value="String(level)" indicator-position="right" @select="execute('title', level)"><template #indicator-icon><Check :size="14" /></template>{{ headingLabel(level) }}</DropdownMenuRadioItem></DropdownMenuRadioGroup>
                </template>
                <template v-if="item === 'image'">
                  <DropdownMenuItem @select="execute('image')">{{ labels.url }}</DropdownMenuItem>
                  <DropdownMenuItem @select="chooseImage()">{{ labels.upload }}</DropdownMenuItem>
                  <DropdownMenuItem @select="chooseImage(true)">{{ labels.crop }}</DropdownMenuItem>
                </template>
                <div v-if="item === 'table'" class="fdl-table-picker">
                  <div class="fdl-table-size" aria-live="polite">{{ tableSize.rows }} × {{ tableSize.cols }}</div>
                  <div v-for="row in 6" :key="row" class="md-editor-table-shape-row"><DropdownMenuItem v-for="col in 6" :key="col" as-child @select="table(row, col)"><button type="button" class="md-editor-table-shape-col" :class="{ 'fdl-table-cell-selected': row <= tableSize.rows && col <= tableSize.cols }" :data-row="row" :data-col="col" :aria-label="`${row} × ${col}`" @pointerenter="tableSize = { rows: row, cols: col }" @focus="tableSize = { rows: row, cols: col }" @keydown="gridKey($event, row, col)" /></DropdownMenuItem></div>
                </div>
              </DropdownMenuContent>
            </div>
          </DropdownMenu>
        </div>
        <div class="md-editor-toolbar-right">
          <slot name="defToolbars" />
          <ToggleGroup
            type="single" :spacing="1" :model-value="structured ? 'structured' : 'source'" :disabled="disabled"
            class="fdl-editor-modes ml-auto shrink-0 gap-0 rounded-md p-0.5"
            :aria-label="modeLabel('editingMode')"
            @update:model-value="updateMode"
          >
            <ToggleGroupItem
              v-for="mode in (['structured', 'source'] as const)" :key="mode" :value="mode"
              class="fdl-editor-mode h-6 min-w-0 rounded px-2 py-0 text-xs font-medium transition-colors disabled:cursor-not-allowed"
              @mousedown.prevent @click="previewOnly = false"
            >{{ modeLabel(mode === 'structured' ? 'structuredMode' : 'sourceMode') }}</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
    </div>
    <div class="md-editor-content fdl-editor-body">
      <div v-show="!previewOnly" class="md-editor-input-wrapper">
        <div v-show="!structured" ref="sourceMount" class="fdl-source-mount" />
        <div v-show="structured" class="fdl-rich-mount"><slot name="visual" /></div>
      </div>
      <div v-if="previewOnly" class="fdl-preview-pane"><ThemedMdPreview :model-value="modelValue" :language="language" :sanitize="sanitize" /></div>
    </div>
    <div v-if="footers.length" class="md-editor-footer" :class="{ 'fdl-footer-right': footers.includes('=') }">
      <span v-if="footers.includes('markdownTotal')">{{ modelValue.length }} {{ labels.count }}</span><slot name="defFooters" />
    </div>
    <MarkdownImageCrop v-if="cropOpen" :language="language" @cancel="cancelCrop" @apply="applyCrop" @restore-focus="emit('restoreFocus')" />
    <input ref="fileInput" type="file" accept="image/*" multiple hidden @change="uploadFiles">
    <MarkdownAddressDialog v-model:description="description" v-model:address="address" :open="!!addressKind" :title="addressKind === 'image' ? labels.image : labels.link" :labels="labels" :disabled="locked" @cancel="cancelAddress" @confirm="confirmAddress" @restore-focus="emit('restoreFocus')" />
    <slot name="overlays" />
  </div>
</template>
