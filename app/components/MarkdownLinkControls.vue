<script setup lang="ts">
import { getMarkRange, type Editor } from '@tiptap/core'
import { ExternalLink, Pencil, Unlink } from 'lucide-vue-next'
import { PopoverRoot, PopoverAnchor, PopoverPortal, PopoverContent } from 'reka-ui'
import { Button } from './ui/button'
import type { toolbarLabels } from '~/lib/markdown-editor-ui'
const props = defineProps<{ editor: Editor, enabled: boolean, labels: typeof toolbarLabels.en }>()
const emit = defineEmits<{ edit: [] }>()
const target = shallowRef<HTMLAnchorElement>()
const href = ref('')
const open = ref(false)
let dismissed = false
let restoreOnClose = false
let frame = 0
let editorElement: HTMLElement | undefined
function sync() {
  const editor = props.editor
  if (!props.enabled || !editor.isEditable || !editor.isActive('link') || dismissed) { open.value = false; return }
  const { $from, to } = editor.state.selection
  const range = getMarkRange($from, editor.schema.marks.link!, editor.getAttributes('link'))
  if (!range || to > range.to) { open.value = false; return }
  const node = editor.view.domAtPos(range.from, 1).node
  const anchor = (node instanceof HTMLElement ? node : node.parentElement)?.closest('a')
  if (!anchor || !editor.view.dom.contains(anchor)) { open.value = false; return }
  target.value = anchor
  href.value = anchor.getAttribute('href') ?? ''
  open.value = !!href.value && (editor.isFocused || open.value)
}
function schedule() { cancelAnimationFrame(frame); frame = requestAnimationFrame(sync) }
function selection() { dismissed = false; schedule() }
function dismiss() { dismissed = true; open.value = false }
function edit() { dismiss(); emit('edit') }
function unlink() {
  dismiss()
  props.editor.chain().focus(undefined, { scrollIntoView: false }).extendMarkRange('link').unsetLink().run()
}
function escape(event: KeyboardEvent) { event.preventDefault(); event.stopPropagation(); restoreOnClose = !props.editor.isFocused; dismiss() }
function closeFocus(event: Event) {
  event.preventDefault()
  if (restoreOnClose && props.enabled) props.editor.view.focus()
  restoreOnClose = false
}
function outside(event: Event) {
  const original = (event as CustomEvent<{ originalEvent: Event }>).detail.originalEvent
  // Selection updates decide which link is active when clicking in the editor.
  if (original.target instanceof Node && props.editor.view.dom.contains(original.target)) event.preventDefault()
}
watch(() => props.enabled, value => { if (!value) dismiss(); else { dismissed = false; schedule() } })
onMounted(() => {
  editorElement = props.editor.view.dom
  props.editor.on('selectionUpdate', selection)
  props.editor.on('transaction', schedule)
  props.editor.on('focus', schedule)
  editorElement.addEventListener('pointerup', selection)
})
onBeforeUnmount(() => {
  cancelAnimationFrame(frame)
  props.editor.off('selectionUpdate', selection)
  props.editor.off('transaction', schedule)
  props.editor.off('focus', schedule)
  editorElement?.removeEventListener('pointerup', selection)
})
</script>
<template>
  <PopoverRoot :open="open && enabled" :modal="false" @update:open="value => { if (!value) dismiss() }">
    <PopoverAnchor :reference="target" as="span" class="sr-only" />
    <PopoverPortal>
      <PopoverContent class="fdl-link-controls" :aria-label="labels.linkActions" side="bottom" align="start" :side-offset="6" :collision-padding="8" hide-when-detached @open-auto-focus.prevent @close-auto-focus="closeFocus" @pointer-down-outside="outside" @focus-outside="outside" @escape-key-down="escape">
        <Button as-child variant="ghost" size="sm" class="fdl-link-destination"><a :href="href" target="_blank" rel="noopener noreferrer" :aria-label="labels.openLink" :title="href"><span>{{ href }}</span><ExternalLink :size="14" /></a></Button>
        <Button type="button" variant="ghost" size="icon" :aria-label="labels.editLink" :title="labels.editLink" @mousedown.prevent @click="edit"><Pencil :size="14" /></Button>
        <Button type="button" variant="ghost" size="icon" :aria-label="labels.unlink" :title="labels.unlink" @mousedown.prevent @click="unlink"><Unlink :size="14" /></Button>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
