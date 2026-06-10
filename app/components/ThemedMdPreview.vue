<script setup lang="ts">
import { MdPreview } from 'md-editor-v3'
import 'md-editor-v3/lib/preview.css'

// Read-only counterpart of ThemedMdEditor: forwards everything (incl. the
// one-way model-value) via $attrs and binds `theme` to the global `<html>.dark`
// contract so rendered markdown follows the app theme automatically.
defineOptions({ inheritAttrs: false })
const theme = useEditorTheme()
</script>

<template>
  <MdPreview :theme="theme" v-bind="$attrs" />
</template>
