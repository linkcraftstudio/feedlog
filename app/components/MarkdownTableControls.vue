<script setup lang="ts">
import type { Editor } from '@tiptap/core'
import { Minus, Plus, Trash2 } from 'lucide-vue-next'
const props = defineProps<{ editor: Editor }>()
const { t } = useI18n()
const root = ref<HTMLElement>()
const geometry = ref<{ x: number, y: number, width: number, height: number, rows: number[], cols: number[] }>()
let host: HTMLElement | null = null
let table: HTMLTableElement | null = null
let observer: ResizeObserver | undefined
let frame = 0
function measure() {
  if (!host || !table?.isConnected || !props.editor.view.dom.contains(table)) { geometry.value = undefined; return }
  const box = table.getBoundingClientRect(), parent = host.getBoundingClientRect()
  geometry.value = { x: box.left - parent.left + host.scrollLeft, y: box.top - parent.top + host.scrollTop, width: box.width, height: box.height,
    rows: Array.from(table.rows, row => row.getBoundingClientRect().top - box.top).concat(box.height),
    cols: Array.from(table.rows[0]?.cells ?? [], cell => cell.getBoundingClientRect().left - box.left).concat(box.width) }
}
function schedule() { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure) }
function track(event: MouseEvent) {
  const target = event.target as HTMLElement
  if (root.value?.contains(target)) return
  const candidate = target.closest('table')
  if (candidate && props.editor.view.dom.contains(candidate)) { if (table !== candidate) table = candidate; measure() }
  else if (!props.editor.isActive('table')) { geometry.value = undefined }
}
function selection() {
  const dom = props.editor.view.domAtPos(props.editor.state.selection.from).node
  const candidate = (dom instanceof HTMLElement ? dom : dom.parentElement)?.closest('table')
  if (candidate) { table = candidate; schedule() }
  else { table = null; geometry.value = undefined }
}
function selectCell(axis: 'row' | 'column', index: number) {
  if (!table?.isConnected || !props.editor.isEditable) return false
  const cell = axis === 'row' ? table.rows[index]?.cells[0] : table.rows[0]?.cells[index]
  if (!cell) return false
  props.editor.commands.setTextSelection(props.editor.view.posAtDOM(cell, 0) + 1)
  return true
}
function insert(axis: 'row' | 'column', boundary: number) {
  const count = axis === 'row' ? table?.rows.length : table?.rows[0]?.cells.length
  if (!count || !selectCell(axis, Math.min(boundary, count - 1))) return
  const chain = props.editor.chain().focus(undefined, { scrollIntoView: false })
  if (axis === 'row') {
    if (boundary === count) chain.addRowAfter().run()
    else chain.addRowBefore().run()
  } else {
    if (boundary === count) chain.addColumnAfter().run()
    else chain.addColumnBefore().run()
  }
  schedule()
}
function remove(axis: 'row' | 'column' | 'table', index = 0) {
  const selected = { axis, index }
  if (!selectCell(selected.axis === 'table' ? 'row' : selected.axis, selected.index)) return
  const chain = props.editor.chain().focus(undefined, { scrollIntoView: false })
  if (selected.axis === 'table') chain.deleteTable().run()
  else if (selected.axis === 'row') chain.deleteRow().run()
  else chain.deleteColumn().run()
  schedule()
}
function leave() { if (!props.editor.isActive('table')) { geometry.value = undefined } }
onMounted(() => {
  host = root.value!.parentElement
  host?.addEventListener('mousemove', track)
  host?.addEventListener('mouseleave', leave)
  observer = new ResizeObserver(schedule)
  observer.observe(props.editor.view.dom)
  if (host) observer.observe(host)
  props.editor.on('transaction', schedule)
  props.editor.on('selectionUpdate', selection)
  selection()
})
onBeforeUnmount(() => {
  cancelAnimationFrame(frame); observer?.disconnect()
  host?.removeEventListener('mousemove', track); host?.removeEventListener('mouseleave', leave)
  props.editor.off('transaction', schedule); props.editor.off('selectionUpdate', selection)
})
</script>
<template>
  <div ref="root" class="fdl-table-controls">
    <div v-if="geometry" class="fdl-table-frame" :style="{ '--table-width': `${geometry.width}px`, '--table-height': `${geometry.height}px`, left: `${geometry.x}px`, top: `${geometry.y}px`, width: `${geometry.width}px`, height: `${geometry.height}px` }">
      <button class="fdl-table-handle corner" type="button" :aria-label="t('markdownEditor.deleteTable')" @mousedown.prevent @click="remove('table')"><Trash2 :size="14" aria-hidden="true" /><span class="fdl-table-tooltip">{{ t('markdownEditor.deleteTable') }}</span></button>
      <button class="fdl-table-append column" type="button" :aria-label="t('markdownEditor.addColumnAfter')" @mousedown.prevent @click="insert('column', geometry.cols.length - 1)"><Plus :size="12" aria-hidden="true" /><span class="fdl-table-tooltip">{{ t('markdownEditor.addColumnAfter') }} →</span></button>
      <button class="fdl-table-append row" type="button" :aria-label="t('markdownEditor.addRowAfter')" @mousedown.prevent @click="insert('row', geometry.rows.length - 1)"><Plus :size="12" aria-hidden="true" /><span class="fdl-table-tooltip">↓ {{ t('markdownEditor.addRowAfter') }}</span></button>
      <button v-for="(y, index) in geometry.rows.slice(0, -1)" :key="`r${index}`" class="fdl-table-insert row" type="button" :style="{ top: `${y}px` }" :aria-label="`${t('markdownEditor.addRowBefore')} ${index + 1}`" @mousedown.prevent @click="insert('row', index)"><Plus :size="12" aria-hidden="true" /><span class="fdl-table-tooltip">↑ {{ t('markdownEditor.insertRowAt', { index: index + 1 }) }}</span></button>
      <button v-for="(x, index) in geometry.cols.slice(0, -1)" :key="`c${index}`" class="fdl-table-insert column" type="button" :style="{ left: `${x}px` }" :aria-label="`${t('markdownEditor.addColumnBefore')} ${index + 1}`" @mousedown.prevent @click="insert('column', index)"><Plus :size="12" aria-hidden="true" /><span class="fdl-table-tooltip">← {{ t('markdownEditor.insertColumnAt', { index: index + 1 }) }}</span></button>
      <button v-for="(y, index) in geometry.rows.slice(0, -1)" :key="`rh${index}`" class="fdl-table-handle row" type="button" :style="{ top: `${(y + geometry.rows[index + 1]!) / 2}px` }" :aria-label="`${t('markdownEditor.deleteRow')} ${index + 1}`" @mousedown.prevent @click="remove('row', index)"><Minus :size="12" aria-hidden="true" /><span class="fdl-table-tooltip">{{ t('markdownEditor.deleteRow') }} {{ index + 1 }}</span></button>
      <button v-for="(x, index) in geometry.cols.slice(0, -1)" :key="`ch${index}`" class="fdl-table-handle column" type="button" :style="{ left: `${(x + geometry.cols[index + 1]!) / 2}px` }" :aria-label="`${t('markdownEditor.deleteColumn')} ${index + 1}`" @mousedown.prevent @click="remove('column', index)"><Minus :size="12" aria-hidden="true" /><span class="fdl-table-tooltip">{{ t('markdownEditor.deleteColumn') }} {{ index + 1 }}</span></button>
    </div>
  </div>
</template>
