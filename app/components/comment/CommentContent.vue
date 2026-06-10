<script setup lang="ts">
import { computed } from 'vue'
import { resolveAttachmentUrls } from '~/utils/attachment'

const props = defineProps<{
  content: string
}>()

const resolvedContent = computed(() => resolveAttachmentUrls(props.content))
</script>

<template>
  <div class="comment-content">
    <ThemedMdPreview :model-value="resolvedContent" language="en-US" />
  </div>
</template>

<style scoped>
/* Remove MdPreview default container styling */
.comment-content :deep(.md-editor) {
  border: none;
  background: transparent;
}
.comment-content :deep(.md-editor-preview-wrapper) {
  padding: 0;
}

/* All headings: flatten to near-body-text size */
.comment-content :deep(h1) {
  font-size: 0.875rem;
  font-weight: 700;
  margin-top: 0.5rem;
  margin-bottom: 0.25rem;
}
.comment-content :deep(h2) {
  font-size: 0.875rem;
  font-weight: 700;
  margin-top: 0.5rem;
  margin-bottom: 0.25rem;
}
.comment-content :deep(h3),
.comment-content :deep(h4),
.comment-content :deep(h5),
.comment-content :deep(h6) {
  font-size: 0.875rem;
  font-weight: 600;
  margin-top: 0.5rem;
  margin-bottom: 0.25rem;
}

/* First heading: no top margin */
.comment-content :deep(h1:first-child),
.comment-content :deep(h2:first-child),
.comment-content :deep(h3:first-child) {
  margin-top: 0;
}

/* Body text: match comment text size */
.comment-content :deep(p) {
  font-size: 0.875rem;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

/* Lists: compact */
.comment-content :deep(ul),
.comment-content :deep(ol) {
  font-size: 0.875rem;
  padding-left: 1.25rem;
  margin: 0.25rem 0;
}
.comment-content :deep(ul) {
  list-style-type: disc;
}
.comment-content :deep(ol) {
  list-style-type: decimal;
}

/* Code blocks: smaller */
.comment-content :deep(pre) {
  font-size: 0.75rem;
  border-radius: 6px;
  margin: 0.5rem 0;
}

/* Inline code */
.comment-content :deep(code:not(pre code)) {
  font-size: 0.8em;
  padding: 0.1em 0.35em;
  border-radius: 3px;
}

/* Reduce spacing between block elements */
.comment-content :deep(.md-editor-preview > *:last-child) {
  margin-bottom: 0;
}
</style>
