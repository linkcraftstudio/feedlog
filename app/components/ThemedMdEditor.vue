<script setup lang="ts">
import { MdEditor } from 'md-editor-v3'
import 'md-editor-v3/lib/style.css'

// Thin forwarding wrapper around md-editor's MdEditor that binds `theme` to the
// global `<html>.dark` contract, so every editor follows the app theme (incl.
// live OS changes) without each call site remembering to pass :theme. All other
// props/listeners flow through via $attrs; v-model and named slots
// (#defToolbars / #defFooters) are forwarded.
defineOptions({ inheritAttrs: false })
const model = defineModel<string>()
const theme = useEditorTheme()
</script>

<template>
  <MdEditor v-model="model" :theme="theme" v-bind="$attrs">
    <template v-for="(_, name) in $slots" #[name]="slotProps">
      <slot :name="name" v-bind="slotProps ?? {}" />
    </template>
  </MdEditor>
</template>
