<script setup lang="ts">
import { computed } from 'vue'
import { resolveAttachmentUrls } from '~/utils/attachment'

const props = defineProps<{
  content: string
}>()

const resolvedContent = computed(() => resolveAttachmentUrls(props.content))
</script>

<template>
  <div class="post-content">
    <ThemedMdPreview :model-value="resolvedContent" language="en-US" />
  </div>
</template>

<style scoped>
/* Remove MdPreview default container styling */
.post-content :deep(.md-editor) {
  border: none;
  background: transparent;
}
.post-content :deep(.md-editor-preview-wrapper) {
  padding: 0;
}

/* Heading sizes: scale down to fit within post card context */
.post-content :deep(h1) {
  font-size: 1.25rem;
  margin-top: 1.25rem;
  margin-bottom: 0.5rem;
}
.post-content :deep(h2) {
  font-size: 1.1rem;
  margin-top: 1rem;
  margin-bottom: 0.5rem;
}
.post-content :deep(h3) {
  font-size: 1rem;
  margin-top: 0.75rem;
  margin-bottom: 0.4rem;
}
.post-content :deep(h4),
.post-content :deep(h5),
.post-content :deep(h6) {
  font-size: 0.9rem;
  margin-top: 0.75rem;
  margin-bottom: 0.4rem;
}

/* First heading: no top margin */
.post-content :deep(h1:first-child),
.post-content :deep(h2:first-child),
.post-content :deep(h3:first-child) {
  margin-top: 0;
}

/* Body text */
.post-content :deep(p) {
  font-size: 0.9rem;
  line-height: 1.7;
  /* Softened foreground that follows light/dark; a fixed rgba(0,0,0,..) was
     invisible on the dark surface. */
  color: color-mix(in oklab, var(--foreground) 85%, transparent);
  overflow-wrap: anywhere;
}

/* Lists */
.post-content :deep(ul),
.post-content :deep(ol) {
  font-size: 0.9rem;
  padding-left: 1.5rem;
}
.post-content :deep(ul) {
  list-style-type: disc;
}
.post-content :deep(ol) {
  list-style-type: decimal;
}

/* Code blocks */
.post-content :deep(pre) {
  font-size: 0.8rem;
  border-radius: 8px;
}

/* Inline code */
.post-content :deep(code:not(pre code)) {
  font-size: 0.85em;
  padding: 0.15em 0.4em;
  border-radius: 4px;
}
</style>
