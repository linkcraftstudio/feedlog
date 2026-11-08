<script setup lang="ts">
import { defineComponent, h, render, shallowRef } from 'vue'
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '~/components/ui/select'
import { createMarkdownCodeView, type CodeLanguageControl } from '~/lib/markdown-code-view'
import MarkdownAddressDialog from './MarkdownAddressDialog.vue'
import MarkdownEditorShell from './MarkdownEditorShell.vue'
import { toolbarFormats, toolbarLabels, createMarkdownToolbarOverflow, normalizeMarkdownClipboard, type UploadImgCallBack } from '~/lib/markdown-editor-ui'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import { Extension } from '@tiptap/core'
import type { Mark } from '@tiptap/pm/model'
import { Plugin, Selection } from '@tiptap/pm/state'
import { history } from '@tiptap/pm/history'
import { Placeholder } from '@tiptap/extensions'
import MarkdownTableControls from './MarkdownTableControls.vue'
import MarkdownLinkControls from './MarkdownLinkControls.vue'
import { createMarkdownManager, loadMarkdown, markdownExtensions, requiresSourcePreservation, parseMarkdownDocument, serializeMarkdown, withinMarkdownLimit } from '~/lib/markdown-editor'
import { markdownImage } from '~/utils/attachment'
import { writingAffordances } from '~/lib/markdown-writing'
import { markdownSelection, restoreMarkdownSelection, mapTextOffset, projectMarkdownDraft } from '~/lib/markdown-selection'
import '~/assets/css/markdown-content.css'
import '~/assets/css/markdown-editor.css'

defineOptions({ inheritAttrs: false })
const props = withDefaults(defineProps<{
  modelValue?: string, placeholder?: string, language?: string,
  toolbars?: readonly (string | number)[], footers?: readonly (string | number)[],
  maxLength?: number, readOnly?: boolean, disabled?: boolean, preview?: boolean,
  sanitize?: (html: string) => string,
  onUploadImg?: (files: File[], callback: UploadImgCallBack) => void | Promise<void>,
  onOnUploadImg?: (files: File[], callback: UploadImgCallBack) => void | Promise<void>,
}>(), { modelValue: '', placeholder: '', language: 'en-US', toolbars: () => [], footers: undefined, maxLength: undefined, sanitize: undefined, onUploadImg: undefined, onOnUploadImg: undefined })
const emit = defineEmits<{ 'update:modelValue': [value: string], onChange: [value: string], onSave: [value: string, html: Promise<string>], onFocus: [event: FocusEvent], onBlur: [event: FocusEvent] }>()
const theme = useEditorTheme()
const { t } = useI18n()
const localize = (key: string) => t(`markdownEditor.${key}`, {}, { locale: props.language === 'zh-CN' ? 'zh' : 'en' })
const shell = ref<InstanceType<typeof MarkdownEditorShell>>()
const manager = createMarkdownManager()
let loaded = loadMarkdown(props.modelValue, manager)
const source = ref(props.modelValue)
const buffer = ref(props.modelValue)
const sourceOnly = ref(loaded.sourceOnly)
const locked = computed(() => props.disabled || props.readOnly)
const error = ref('')
const addressKind = ref<'link' | 'image'>()
const address = ref('')
const description = ref('')
const labels = computed(() => toolbarLabels[props.language === 'zh-CN' ? 'zh' : 'en'])
function openAddress(kind: 'link' | 'image') {
  if (kind === 'link' && editor.value?.isActive('link')) editor.value.commands.extendMarkRange('link')
  preparedDoc = editor.value?.state.doc
  addressKind.value = kind
  address.value = kind === 'link' ? editor.value?.getAttributes('link').href ?? '' : ''
  description.value = editor.value?.state.doc.textBetween(editor.value.state.selection.from, editor.value.state.selection.to, ' ') ?? ''
  buffer.value = source.value
}
function cancelAddress() { addressKind.value = undefined; preparedDoc = undefined }
function restoreFocus() { if (sourceOnly.value) shell.value?.focus(); else editor.value?.view.focus() }
function confirmAddress() {
  if (!address.value.trim() || !editor.value || locked.value) return
  if (preparedDoc && preparedDoc !== editor.value.state.doc) { error.value = localize('staleInsertion'); addressKind.value = undefined; return }
  if (addressKind.value === 'image') editor.value.chain().focus().setImage({ src: address.value.trim(), alt: description.value }).run()
  else {
    const text = description.value || address.value.trim()
    const { from, to } = editor.value.state.selection
    if (from !== to && text === editor.value.state.doc.textBetween(from, to, ' ')) editor.value.chain().focus().setLink({ href: address.value.trim() }).run()
    else editor.value.chain().focus().insertContent({ type: 'text', text, marks: [{ type: 'link', attrs: { href: address.value.trim() } }] }).run()
  }
  addressKind.value = undefined
  preparedDoc = undefined
}
let preferredMode: 'structured' | 'source' = 'structured'
let syncing = false
let epoch = 0
let disposed = false
let toolbarOverflow: ReturnType<typeof createMarkdownToolbarOverflow> | undefined
let preparedDoc: object | undefined
let sourceHistoryBody = props.modelValue
let modeTransition = 0
let visualSelection: { source: string, doc: object, selection: Selection, marks: readonly Mark[] | null, anchor: number, head: number } | undefined
let pendingSourceDraft: { source: string, value: string, from: number, to: number, active: boolean } | undefined
function sourceBuffer() {
  return sourceOnly.value && pendingSourceDraft?.active && pendingSourceDraft.source === source.value ? pendingSourceDraft.value : source.value
}

function publish(value: string) {
  source.value = value
  buffer.value = value
  emit('update:modelValue', value)
  emit('onChange', value)
}
const limitGuard = Extension.create({
  name: 'markdownLengthLimit',
  addProseMirrorPlugins() {
    return [new Plugin({ filterTransaction(transaction) {
      if (!transaction.docChanged || syncing) return true
      const valid = withinMarkdownLimit(serializeMarkdown(transaction.doc.toJSON(), loaded, manager), source.value, props.maxLength)
      error.value = valid ? '' : localize('tooLong')
      return valid
    } })]
  },
})
const languageControls = new WeakMap<HTMLElement, ReturnType<typeof shallowRef<Parameters<CodeLanguageControl>[1]>>>()
const codeView = createMarkdownCodeView((host, state) => {
  if (!state) { render(null, host); languageControls.delete(host); return }
  const existing = languageControls.get(host)
  if (existing) { existing.value = state; return }
  const selected = shallowRef(state)
  languageControls.set(host, selected)
  // Keep one Vue tree per node; transactions update it after ProseMirror finishes.
  render(h(defineComponent({ setup: () => {
    let languageChanged = false
    return () => {
      const state = selected.value
      return h(Select, {
        modelValue: state.value, disabled: state.disabled,
        'onUpdate:modelValue': value => { if (typeof value === 'string') { languageChanged = true; state.onChange(value) } },
      }, { default: () => [
        h(SelectTrigger, { class: 'fdl-code-language', size: 'sm', 'aria-label': state.label, title: state.label }, { default: () => h(SelectValue, {}, { default: () => state.options.find(option => option.value === state.value)?.label }) }),
        h(SelectContent, { class: 'max-h-72', onCloseAutoFocus: (event: Event) => { if (languageChanged) { event.preventDefault(); languageChanged = false; editor.value?.view.focus() } } }, {
          default: () => state.options.map(option => h(SelectItem, { key: option.value, value: option.value }, { default: () => option.label })),
        }),
      ] })
    }
  } })), host)
})
const editor = useEditor({
  content: loaded.json, editable: !locked.value && !sourceOnly.value,
  extensions: [...markdownExtensions(codeView), Placeholder.configure({ placeholder: () => props.placeholder }), writingAffordances(), limitGuard],
  editorProps: {
    transformPastedHTML: html => normalizeMarkdownClipboard(html).html,
    attributes: { class: 'md-editor-preview default-theme fdl-editor-content', role: 'textbox', 'aria-multiline': 'true', 'aria-label': props.placeholder, 'data-code-language': localize('codeLanguage'), 'data-code-plain-text': localize('plainText'), 'data-code-collapse': localize('collapseCode') },
    handleKeyDown(_view, event) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && props.toolbars.includes('link') && !locked.value) { event.preventDefault(); openAddress('link'); return true }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); shell.value?.triggerSave(); return true }
      return false
    },
    handlePaste(view, event) {
      if (locked.value) return true
      const files = Array.from(event.clipboardData?.files ?? []).filter(file => file.type.startsWith('image/'))
      if (files.length) { void upload(files, urls => insertUploaded(urls)); return true }
      if (view.state.selection.$from.parent.type.spec.code) return false
      const text = event.clipboardData?.getData('text/plain') ?? ''
      if (!text) return false
      const html = event.clipboardData?.getData('text/html')
      if (html && !normalizeMarkdownClipboard(html).preferText) return false
      if (requiresSourcePreservation(text)) view.dispatch(view.state.tr.insertText(text))
      else {
        const json = parseMarkdownDocument(text, manager)
        // A whole-document paste should not introduce Markdown spacing or rewrite
        // bare URLs before the user has made any edits, just like opening a file.
        if (view.state.doc.childCount === 1 && view.state.doc.firstChild?.type.name === 'paragraph' && !view.state.doc.firstChild.content.size) {
          loaded = { source: text, json, sourceOnly: false }
        }
        editor.value?.commands.insertContent(json)
      }
      return true
    },
    handleDrop(view, event) {
      const files = Array.from(event.dataTransfer?.files ?? []).filter(file => file.type.startsWith('image/'))
      if (!files.length) return false
      if (!locked.value) {
        const hit = view.posAtCoords({ left: event.clientX, top: event.clientY })
        if (hit) view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(hit.pos))))
        void upload(files, urls => insertUploaded(urls))
      }
      return true
    },
  },
  onFocus({ event }) { emit('onFocus', event) },
  onBlur({ event }) { emit('onBlur', event) },
  onCreate({ editor: instance }) { loaded.json = instance.getJSON(); scheduleToolbarSync() },
  onTransaction() { scheduleToolbarSync() },
  onUpdate({ editor: instance }) {
    if (syncing || sourceOnly.value) return
    publish(serializeMarkdown(instance.getJSON(), loaded, manager))
  },
})
let toolbarSyncPending = false
function scheduleToolbarSync() {
  if (toolbarSyncPending || disposed) return
  toolbarSyncPending = true
  nextTick(() => { toolbarSyncPending = false; if (!disposed) syncToolbarState() })
}
const activeFormats = ref<string[]>([])
const headingLevel = ref(0)
function syncToolbarState() {
  headingLevel.value = sourceOnly.value ? 0 : [1, 2, 3, 4, 5, 6].find(level => editor.value?.isActive('heading', { level })) ?? 0
  activeFormats.value = sourceOnly.value ? [] : Object.keys(toolbarFormats).filter(key => editor.value?.isActive(toolbarFormats[key]!))
}
watch([sourceOnly, () => props.language], () => { scheduleToolbarSync(); toolbarOverflow?.refresh() }, { flush: 'post' })
function handleCommand(key: string, value?: number) {
  if (sourceOnly.value || locked.value || !editor.value) return
  const instance = editor.value
  if (key === 'link' || key === 'image') { openAddress(key); return }
  const commands: Record<string, () => unknown> = {
    paragraph: () => instance.commands.setParagraph(),
    title: () => instance.commands.setHeading({ level: (value ?? 2) as 1 | 2 | 3 | 4 | 5 | 6 }),
    table: () => instance.commands.insertTable({ rows: Math.floor((value ?? 303) / 100), cols: (value ?? 303) % 100, withHeaderRow: true }),
    codeRow: () => instance.commands.toggleCode(), code: () => instance.commands.toggleCodeBlock(),
    quote: () => instance.commands.toggleBlockquote(), unorderedList: () => instance.commands.toggleBulletList(),
    orderedList: () => instance.commands.toggleOrderedList(), task: () => instance.commands.toggleTaskList(),
    bold: () => instance.commands.toggleBold(), italic: () => instance.commands.toggleItalic(),
    strikeThrough: () => instance.commands.toggleStrike(), revoke: () => instance.commands.undo(), next: () => instance.commands.redo(),
  }
  commands[key]?.()
  instance.view.focus()
}
function syncSource() {
  const view = shell.value?.getEditorView()
  const value = sourceBuffer()
  if (!view || view.state.doc.toString() === value) return
  syncing = true
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
  syncing = false
}
function applySource(value: string) {
  if (syncing || locked.value || !sourceOnly.value) return
  if (sourceOnly.value && pendingSourceDraft) {
    if (value === pendingSourceDraft.value) {
      pendingSourceDraft.active = true
      if (source.value !== pendingSourceDraft.source) publish(pendingSourceDraft.source)
      buffer.value = pendingSourceDraft.value
      return
    }
  }
  if (value === source.value) {
    if (pendingSourceDraft) pendingSourceDraft.active = false
    buffer.value = value; return
  }
  if (!withinMarkdownLimit(value, source.value, props.maxLength)) { buffer.value = sourceBuffer(); error.value = localize('tooLong'); nextTick(syncSource); return }
  if (sourceOnly.value) { if (pendingSourceDraft) pendingSourceDraft.active = false; publish(value); return }
}
async function setMode(mode: 'structured' | 'source') {
  if (props.disabled || !editor.value) return
  const instance = editor.value
  toolbarOverflow?.close()
  const transition = ++modeTransition
  const documentEpoch = epoch
  const wasSource = sourceOnly.value
  const enteringSource = mode === 'source' && !wasSource
  const enteringVisual = mode === 'structured' && wasSource
  let sourceSelection: { from: number, to: number } | undefined
  const sourceCaret = wasSource ? shell.value?.getEditorView()?.state.selection.main : undefined
  const resetSourceHistory = enteringSource && source.value !== sourceHistoryBody
  if (enteringSource) {
    visualSelection = { source: source.value, doc: instance.state.doc, selection: instance.state.selection, marks: instance.state.storedMarks, anchor: 0, head: 0 }
    const normalized = manager.serialize(instance.getJSON())
    const mapped = markdownSelection(instance, manager)
    const pending = instance.state.selection.empty && !!instance.state.storedMarks?.length && mapped.source !== normalized
    const targetSource = pending ? projectMarkdownDraft(normalized, mapped.source, source.value) : source.value
    const from = mapTextOffset(mapped.source, targetSource, mapped.from)
    const to = mapTextOffset(mapped.source, targetSource, mapped.to)
    const backward = instance.state.selection.anchor > instance.state.selection.head
    sourceSelection = { from: backward ? to : from, to: backward ? from : to }
    if (pending) pendingSourceDraft = { source: source.value, value: targetSource, ...sourceSelection, active: true }
    visualSelection.anchor = sourceSelection.from
    visualSelection.head = sourceSelection.to
  }
  if (wasSource) sourceHistoryBody = source.value
  addressKind.value = undefined
  shell.value?.togglePreviewOnly(false)
  error.value = ''
  if (enteringVisual) {
    const current = serializeMarkdown(instance.getJSON(), loaded, manager)
    if (loaded.sourceOnly || current !== source.value) {
      const next = loadMarkdown(source.value, manager)
      if (next.sourceOnly) { error.value = t('markdownEditor.unsupportedStructured'); return }
      syncing = true
      instance.commands.setContent(next.json, { emitUpdate: false })
      instance.unregisterPlugin('history'); instance.registerPlugin(history())
      loaded = { ...next, json: instance.getJSON() }
      syncing = false
    }
    const unchanged = visualSelection?.source === source.value && visualSelection.doc === instance.state.doc
    if (unchanged && (!sourceCaret || (sourceCaret.anchor === visualSelection!.anchor && sourceCaret.head === visualSelection!.head))) {
      instance.view.dispatch(instance.state.tr.setSelection(visualSelection!.selection).setStoredMarks(visualSelection!.marks))
    } else if (sourceCaret) {
      const toBody = (offset: number) => pendingSourceDraft?.active
        ? mapTextOffset(pendingSourceDraft.value, pendingSourceDraft.source, offset)
        : offset
      restoreMarkdownSelection(instance, manager, source.value, toBody(sourceCaret.anchor), toBody(sourceCaret.head))
    }
    pendingSourceDraft = undefined
    visualSelection = undefined
  }
  preferredMode = mode
  sourceOnly.value = mode === 'source'
  buffer.value = sourceBuffer()
  preparedDoc = undefined
  instance.setEditable(!locked.value && !sourceOnly.value, false)
  instance.commands.command(() => true)
  await nextTick()
  if (transition !== modeTransition || documentEpoch !== epoch || disposed) return
  findTargets()
  if (enteringSource) syncSource()
  if (resetSourceHistory || (enteringSource && pendingSourceDraft)) shell.value?.resetHistory()
  const view = shell.value?.getEditorView()
  if (sourceSelection && view) {
    syncing = true
    view.dispatch({ selection: { anchor: sourceSelection.from, head: sourceSelection.to }, scrollIntoView: true })
    syncing = false
  }
  view?.requestMeasure()
  await nextTick()
  if (transition !== modeTransition || documentEpoch !== epoch || disposed) return
  syncToolbarState()
  if (sourceOnly.value) view?.focus()
  else instance.view.focus()
}
watch(() => props.modelValue, value => {
  if (value === source.value) return
  shell.value?.dismissDialogs()
  addressKind.value = undefined
  pendingSourceDraft = undefined; visualSelection = undefined
  modeTransition++; epoch++; sourceHistoryBody = value; preparedDoc = undefined; error.value = ''; source.value = value; buffer.value = value
  loaded = loadMarkdown(value, manager)
  sourceOnly.value = preferredMode === 'source' || loaded.sourceOnly
  if (editor.value) {
    syncing = true
    editor.value.commands.setContent(loaded.json, { emitUpdate: false })
    editor.value.unregisterPlugin('history'); editor.value.registerPlugin(history())
    editor.value.view.dispatch(editor.value.state.tr.setSelection(Selection.atEnd(editor.value.state.doc)).setStoredMarks(null))
    loaded.json = editor.value.getJSON()
    editor.value.setEditable(!locked.value && !sourceOnly.value, false)
    syncing = false
  }
  nextTick(() => {
    // Synchronize external replacements after the source surface updates.
    syncSource()
    shell.value?.resetHistory()
  })
})
watch(locked, value => { editor.value?.setEditable(!value && !sourceOnly.value, false); editor.value?.commands.command(() => true) })
watch([() => props.placeholder, () => props.language], ([placeholder]) => {
  editor.value?.setOptions({ editorProps: { attributes: { ...editor.value.options.editorProps.attributes, 'aria-label': placeholder, 'data-code-language': localize('codeLanguage'), 'data-code-plain-text': localize('plainText'), 'data-code-collapse': localize('collapseCode') } } })
  editor.value?.commands.command(() => true)
})
async function upload(files: File[], callback: UploadImgCallBack) {
  const handler = props.onOnUploadImg ?? props.onUploadImg
  if (locked.value || !handler) { error.value = localize('uploadUnavailable'); return }
  error.value = ''
  const currentEpoch = epoch
  try {
    await handler(files, urls => {
      if (disposed || epoch !== currentEpoch || locked.value) return
      if (!urls.length) { error.value = localize('uploadFailed'); return }
      // Insert at the current caret after any intervening typing.
      callback(urls)
    })
  } catch (cause) {
    if (!disposed && epoch === currentEpoch && !locked.value) error.value = localize(cause instanceof Error && cause.message === 'partialUpload' ? 'partialUpload' : 'uploadFailed')
  }
}
function handleUpload(files: File[]) { void upload(files, insertUploaded) }
function handleSave(_value: string, html: Promise<string>) { emit('onSave', source.value, html) }
function sourceFocus(event: FocusEvent) { if (sourceOnly.value) emit('onFocus', event) }
function sourceBlur(event: FocusEvent) { if (sourceOnly.value) emit('onBlur', event) }
function insertUploaded(urls: Parameters<UploadImgCallBack>[0]) {
  if (!urls.length) return
  if (sourceOnly.value) {
    shell.value?.insert(() => ({
      targetValue: urls.map(item => {
        const image: { url: string, alt?: string, title?: string } = typeof item === 'string' ? { url: item } : item
        return markdownImage({ src: image.url, alt: image.alt, title: image.title }) + '\n'
      }).join(''),
      select: false,
    }))
    return
  }
  const images = urls.map(item => ({ type: 'image', attrs: typeof item === 'string' ? { src: item } : { src: item.url, alt: item.alt, title: item.title } }))
  editor.value?.chain().focus().insertContent(images).run()
  preparedDoc = undefined
}
function findTargets() {
  const root = shell.value?.$el
  if (!(root instanceof HTMLElement)) return
  if (root.querySelector('.md-editor-toolbar')) {
    if (!toolbarOverflow?.toolbar.isConnected) {
      toolbarOverflow?.destroy()
      toolbarOverflow = createMarkdownToolbarOverflow(root, () => localize('moreTools'), () => shell.value?.closeToolbarMenu())
    }
    toolbarOverflow.refresh()
  } else { toolbarOverflow?.destroy(); toolbarOverflow = undefined }
  scheduleToolbarSync()
}
onMounted(() => { findTargets() })
watch(() => props.toolbars, () => nextTick(findTargets), { deep: true })
onBeforeUnmount(() => { disposed = true; epoch++; toolbarOverflow?.destroy(); editor.value?.destroy() })
defineExpose({
  setMode, getEditorView: () => shell.value?.getEditorView(),
  focus: () => sourceOnly.value ? shell.value?.focus() : editor.value?.commands.focus(),
  getSelectedText: () => sourceOnly.value ? shell.value?.getSelectedText() : editor.value?.state.doc.textBetween(editor.value.state.selection.from, editor.value.state.selection.to, '\n'),
  triggerSave: () => shell.value?.triggerSave(),
  resetHistory: () => { shell.value?.resetHistory(); if (editor.value) { editor.value.unregisterPlugin('history'); editor.value.registerPlugin(history()) } },
})
</script>
<template>
  <MarkdownEditorShell
    ref="shell" v-bind="$attrs" :model-value="buffer" :structured="!sourceOnly" :theme="theme" :language="language" :placeholder="placeholder"
    :toolbars="toolbars" :footers="footers" :active-formats="activeFormats" :heading-level="headingLevel" :read-only="readOnly" :disabled="disabled" :sanitize="sanitize"
    @update:model-value="applySource" @command="handleCommand" @mode-change="setMode" @upload-images="handleUpload" @restore-focus="restoreFocus"
    @on-save="handleSave"
    @on-focus="sourceFocus" @on-blur="sourceBlur"
  >
    <template #visual>
      <div class="fdl-editor-scroll fdl-rich-scroll">
        <EditorContent class="fdl-editor-mount" :editor="editor" />
        <MarkdownLinkControls v-if="editor && toolbars.includes('link')" :editor="editor" :enabled="!sourceOnly && !locked && !addressKind" :labels="labels" @edit="openAddress('link')" />
        <MarkdownTableControls v-if="editor && toolbars.includes('table') && !locked" :editor="editor" />
      </div>
    </template>
    <template #defToolbars><slot name="defToolbars" /></template>
    <template #defFooters><slot name="defFooters" /></template>
    <template #overlays>
      <MarkdownAddressDialog v-model:description="description" v-model:address="address" :open="!!addressKind" :title="addressKind === 'image' ? labels.image : labels.link" :labels="labels" :disabled="locked" @cancel="cancelAddress" @confirm="confirmAddress" @restore-focus="restoreFocus" />
      <p v-if="error" class="fdl-editor-message text-destructive" role="alert">{{ error }}</p>
    </template>
  </MarkdownEditorShell>
</template>
