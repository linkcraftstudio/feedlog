<script setup lang="ts">
import DOMPurify from 'dompurify'
defineProps<{ text: string; variant?: 'chat' | 'article' }>()
const id = useId()
function sanitize(html: string) {
  const fragment = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['style', 'form', 'input'],
    RETURN_DOM_FRAGMENT: true,
  })
  fragment.querySelectorAll('button').forEach(button => {
    if (!button.matches('.fdl-code-copy, .fdl-code-collapse') || !button.closest('.md-editor-code-head')) button.remove()
    else button.type = 'button'
  })
  // Links must not replace the iframe and leave the customer outside the chat.
  fragment.querySelectorAll('a[href]').forEach(link => {
    link.setAttribute('target', '_blank')
    link.setAttribute('rel', 'noopener noreferrer')
  })
  const container = document.createElement('div')
  container.append(fragment)
  return container.innerHTML
}
</script>

<template>
  <ClientOnly>
    <ThemedMdPreview :editor-id="id" :model-value="text" :sanitize="sanitize" :class="variant === 'article' ? 'widget-article-markdown' : 'widget-markdown'" />
    <template #fallback><span class="whitespace-pre-wrap">{{ text }}</span></template>
  </ClientOnly>
</template>

<style scoped>
.widget-markdown { background: transparent; color: inherit; font-size: inherit; font-family: inherit; }
.widget-markdown :deep(.md-editor-preview-wrapper) { padding: 0; color: inherit; }
.widget-markdown :deep(.md-editor-preview) { color: inherit; font-size: inherit; word-break: break-word; }
.widget-markdown :deep(.md-editor-preview p) { line-height: inherit; }
.widget-markdown :deep(.md-editor-preview ul) { list-style-type: disc; }
.widget-markdown :deep(.md-editor-preview ol) { list-style-type: decimal; }
.widget-markdown :deep(.md-editor-preview :is(ul, ol)) {
  margin-block: 0.4em;
  padding-inline-start: 1.4em;
}
.widget-markdown :deep(.md-editor-preview li) { margin-block: 0.2em; }
.widget-markdown :deep(.md-editor-preview li > :is(p, ul, ol)) { margin-block: 0.2em; }
.widget-markdown :deep(.md-editor-preview > :first-child) { margin-top: 0; }
.widget-markdown :deep(.md-editor-preview > :last-child) { margin-bottom: 0; }
:is(.widget-markdown, .widget-article-markdown) :deep(.md-editor-preview a) {
  border-block-end: none;
  text-underline-offset: 0.15em;
}
:is(.widget-markdown, .widget-article-markdown) :deep(.md-editor-preview a:hover) {
  text-decoration: underline;
}
:is(.widget-markdown, .widget-article-markdown) :deep(a[target='_blank']::after) {
  width: 0.9em;
  height: 0.9em;
  margin-inline-start: 0.2em;
  vertical-align: baseline;
  opacity: 0.8;
}
.widget-markdown :deep(pre) { max-width: 100%; overflow-x: auto; }
</style>
