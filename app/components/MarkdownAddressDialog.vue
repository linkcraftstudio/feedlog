<script setup lang="ts">
import { Dialog, DialogContent, DialogTitle, DialogFooter } from './ui/dialog'
import { Input } from './ui/input'
import { Button } from './ui/button'
import type { toolbarLabels } from '~/lib/markdown-editor-ui'
const props = defineProps<{ open: boolean, title: string, labels: typeof toolbarLabels.en, disabled?: boolean }>()
const emit = defineEmits<{ cancel: [], confirm: [], restoreFocus: [] }>()
const address = defineModel<string>('address', { required: true })
const description = defineModel<string>('description', { required: true })
const id = useId()
function focusAddress(event: Event) {
  event.preventDefault()
  document.getElementById(`${id}-address`)?.focus()
}
function submitOnEnter(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229 || !(event.target instanceof HTMLInputElement)) return
  event.preventDefault(); confirm()
}
function confirm() { if (address.value.trim() && !props.disabled) emit('confirm') }
</script>
<template>
  <Dialog :open="open" @update:open="value => { if (!value) emit('cancel') }">
    <DialogContent class="fdl-address-dialog" :show-close-button="false" :aria-describedby="undefined" @open-auto-focus="focusAddress" @close-auto-focus="event => { event.preventDefault(); emit('restoreFocus') }" @keydown.enter="submitOnEnter">
      <DialogTitle>{{ title }}</DialogTitle>
      <div class="grid gap-2"><label :for="`${id}-description`">{{ labels.description }}</label><Input :id="`${id}-description`" v-model="description" :placeholder="labels.description" /></div>
      <div class="grid gap-2"><label :for="`${id}-address`">{{ labels.addressLabel }}</label><Input :id="`${id}-address`" v-model="address" :placeholder="labels.address" /></div>
      <DialogFooter><Button type="button" variant="outline" @click="emit('cancel')">{{ labels.cancel }}</Button><Button type="button" :disabled="!address.trim() || disabled" @click="confirm">{{ labels.ok }}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
</template>
