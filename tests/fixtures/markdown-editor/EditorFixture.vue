<script setup lang="ts">
import { ref, nextTick } from 'vue'
import Editor from '../../../app/components/ThemedMdEditor.vue'
import WidgetMarkdown from '../../../app/components/WidgetEmbed/WidgetEmbedMarkdown.vue'
import ThemedMdPreview from '../../../app/components/ThemedMdPreview.vue'
import '../../../app/assets/css/help-article.css'
const language = ref('en-US')
const widgetVisible = ref(false)
const value = ref('')
const instance = ref()
const bare = ref('')
const readOnly = ref(false)
const limit = ref<number>()
const uploaded = ref(0)
const receivedFiles = ref<{ name: string, type: string, size: number }[]>([])
const uploadDelay = ref(20)
const uploadResult = ref<string[]>()
const updates = ref(0)
const submissions = ref(0)
const toolbar = ['bold', 'italic', 'strikeThrough', '-', 'title', 'unorderedList', 'orderedList', '-', 'link', 'image', 'code', 'codeRow', 'table', 'previewOnly', 'fullscreen', '=', 0]
const upload = async (_files: File[], callback: (urls: string[]) => void) => {
  uploaded.value++
  receivedFiles.value = _files.map(({ name, type, size }) => ({ name, type, size }))
  await new Promise(resolve => setTimeout(resolve, uploadDelay.value))
  callback(uploadResult.value ?? ['attachment:uploads/截屏 (1).png'])
}
Object.assign(window, { fixture: { instance, value, language, widgetVisible, bare, readOnly, limit, uploaded, receivedFiles, uploadDelay, uploadResult, updates, submissions, nextTick } })
</script>
<template>
  <form id="full" @submit.prevent="submissions++">
    <Editor ref="instance" v-model="value" style="height: 280px" :toolbars="toolbar" :footers="['=', 0]" :max-length="limit" :read-only="readOnly" placeholder="Write a comment" :language="language" @on-upload-img="upload" @update:model-value="updates++">
      <template #defToolbars><button id="custom-tool" type="button">AI</button></template>
      <template #defFooters><button id="submit" type="button">Submit</button></template>
    </Editor>
  </form>
  <div id="public-preview" class="help-article-styled"><ThemedMdPreview :model-value="value" :language="language" /></div>
  <div v-if="widgetVisible" id="widget-preview"><WidgetMarkdown :text="value" /></div>
  <div id="bare"><Editor v-model="bare" :footers="[]" style="height: 160px" placeholder="Reply" /></div>
</template>
<style>
:root { --background:#fff; --foreground:#18181b; --border:#e4e4e7; --muted:#f4f4f5; --muted-foreground:#71717a; --secondary:#f4f4f5; --primary:#2563eb; --popover:#fff; --accent:#e57a5a; --ring:#2563eb; }
.dark { --background:#18181b; --foreground:#fafafa; --border:#3f3f46; --muted:#27272a; --secondary:#27272a; --popover:#18181b; --accent:#e57a5a; }
* { box-sizing:border-box; } body { font-family:Arial,sans-serif; margin:24px; max-width:800px; background:var(--background); color:var(--foreground); } button { border:0; background:transparent; color:inherit; } #bare { margin-top:24px; }
</style>

<style scoped>
.caller-editor-height { height: 420px; }
</style>
