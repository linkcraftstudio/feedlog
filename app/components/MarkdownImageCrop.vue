<script setup lang="ts">
import Cropper from 'cropperjs'
import 'cropperjs/dist/cropper.css'
import { Maximize2, Minimize2, Trash2, Upload, X } from 'lucide-vue-next'
import { Dialog, DialogContent, DialogTitle, DialogFooter } from './ui/dialog'
import { Button } from './ui/button'
const props = defineProps<{ language: string }>()
const emit = defineEmits<{ cancel: [], restoreFocus: [], apply: [file: File] }>()
const input = ref<HTMLInputElement>()
const image = ref<HTMLImageElement>()
const preview = ref<HTMLElement>()
const source = ref('')
const ready = ref(false), error = ref(false), exporting = ref(false)
const fullscreen = ref(false)
const offset = ref({ x: 0, y: 0 })
const zh = computed(() => props.language === 'zh-CN')
let cropper: Cropper | undefined
let file: File | undefined
let disposed = false
let drag: { x: number, y: number, left: number, top: number } | undefined
function focusChoose(event: Event) { event.preventDefault(); nextTick(() => input.value?.parentElement?.querySelector<HTMLButtonElement>('.fdl-crop-choose')?.focus()) }
function initialize() {
  cropper?.destroy(); cropper = undefined; ready.value = false
  if (!image.value || !source.value) return
  cropper = new Cropper(image.value, { viewMode: 2, preview: preview.value, ready: () => { ready.value = true } })
}
function reset() {
  cropper?.destroy(); cropper = undefined
  if (source.value) URL.revokeObjectURL(source.value)
  source.value = ''; ready.value = false; error.value = false; file = undefined
  if (input.value) input.value.value = ''
}
function select(event: Event) {
  const next = (event.target as HTMLInputElement).files?.[0]
  if (!next) return
  reset(); file = next; source.value = URL.createObjectURL(next)
  nextTick(initialize)
}
function remove() { reset(); nextTick(() => input.value?.parentElement?.querySelector<HTMLButtonElement>('.fdl-crop-choose')?.focus()) }
function apply() {
  if (!cropper || !file || !ready.value || exporting.value) return
  exporting.value = true
  const name = file.name.replace(/\.[^.]+$/, '') + '.png'
  cropper.getCroppedCanvas().toBlob(blob => {
    if (disposed) return
    exporting.value = false
    if (blob) emit('apply', new File([blob], name, { type: 'image/png' }))
    else error.value = true
  }, 'image/png')
}
function startDrag(event: PointerEvent) {
  if (fullscreen.value || (event.target as Element).closest('button')) return
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  drag = { x: event.clientX, y: event.clientY, left: offset.value.x, top: offset.value.y }
}
function moveDrag(event: PointerEvent) {
  if (!drag) return
  offset.value = { x: drag.left + event.clientX - drag.x, y: drag.top + event.clientY - drag.y }
}
watch(fullscreen, () => nextTick(initialize))
onBeforeUnmount(() => { disposed = true; reset() })
</script>
<template>
  <Dialog :open="true" @update:open="value => { if (!value) emit('cancel') }">
    <DialogContent class="fdl-crop-dialog" :class="{ 'fdl-crop-fullscreen': fullscreen }" :style="fullscreen ? undefined : { marginLeft: `${offset.x}px`, marginTop: `${offset.y}px` }" :show-close-button="false" :aria-describedby="undefined" @open-auto-focus="focusChoose" @close-auto-focus="event => { event.preventDefault(); emit('restoreFocus') }">
      <header class="fdl-crop-header" @pointerdown="startDrag" @pointermove="moveDrag" @pointerup="drag = undefined" @pointercancel="drag = undefined">
        <DialogTitle>{{ zh ? '裁剪并上传' : 'Crop And Upload' }}</DialogTitle>
        <div><Button type="button" variant="ghost" size="icon-sm" :aria-label="fullscreen ? (zh ? '还原' : 'Restore') : (zh ? '放大' : 'Expand')" @click="fullscreen = !fullscreen"><component :is="fullscreen ? Minimize2 : Maximize2" :size="16" /></Button><Button type="button" variant="ghost" size="icon-sm" :aria-label="zh ? '关闭' : 'Close'" @click="emit('cancel')"><X :size="18" /></Button></div>
      </header>
      <div class="fdl-crop-content">
        <div class="fdl-crop-workspace">
          <div class="fdl-crop-main">
            <template v-if="source"><img ref="image" :src="source" alt="" @error="error = true"><Button type="button" variant="secondary" size="icon-sm" class="fdl-crop-remove" :aria-label="zh ? '删除图片' : 'Remove image'" @click="remove"><Trash2 :size="16" /></Button></template>
            <button v-else class="fdl-crop-choose" type="button" :aria-label="zh ? '选择图片' : 'Choose image'" @click="input?.click()"><Upload :size="40" aria-hidden="true" /></button>
          </div>
          <div class="fdl-crop-preview-pane" :aria-label="zh ? '裁剪预览' : 'Crop preview'"><div ref="preview" class="fdl-crop-preview" /></div>
        </div>
        <p v-if="error" role="alert">{{ zh ? '无法读取或裁剪图片' : 'Unable to read or crop image' }}</p>
        <DialogFooter class="fdl-crop-footer"><Button type="button" variant="outline" @click="emit('cancel')">{{ zh ? '取消' : 'Cancel' }}</Button><Button type="button" :disabled="!ready || exporting || error" @click="apply">{{ zh ? '上传' : 'Upload' }}</Button></DialogFooter>
        <input ref="input" type="file" accept="image/*" hidden @change="select">
      </div>
    </DialogContent>
  </Dialog>
</template>
