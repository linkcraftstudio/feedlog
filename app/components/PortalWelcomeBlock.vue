<script setup lang="ts">
import { resolveAttachmentUrls } from '~/utils/attachment'

const localePath = useLocalePath()

const props = defineProps<{
  title: string
  description: string
  editable?: boolean
}>()

const resolvedDescription = computed(() => resolveAttachmentUrls(props.description))
const hasContent = computed(() => props.title.trim().length > 0 || props.description.trim().length > 0)
</script>

<template>
  <section
    v-if="hasContent"
    class="welcome-block group relative overflow-hidden rounded-xl border border-primary/20 bg-primary/5 px-5 py-5 sm:px-6 sm:py-6"
  >
    <Button
      v-if="editable"
      as-child
      variant="secondary"
      size="sm"
      class="absolute right-3 top-3 opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-within:opacity-100"
    >
      <NuxtLink :to="localePath('/dashboard/settings/portal')">
        <Icon name="lucide:pencil" size="14" />
        Edit
      </NuxtLink>
    </Button>

    <div class="max-w-2xl pr-16 sm:pr-24">
      <h1 v-if="title" class="font-heading text-xl sm:text-2xl font-bold tracking-tight text-foreground">
        {{ title }}
      </h1>
      <ThemedMdPreview
        v-if="description"
        :model-value="resolvedDescription"
        language="en-US"
        class="mt-2"
      />
    </div>
  </section>
</template>

<style scoped>
.welcome-block :deep(.md-editor) {
  background: transparent;
  border: none;
}

.welcome-block :deep(.md-editor-preview-wrapper) {
  padding: 0;
}

.welcome-block :deep(.md-editor-preview) {
  background: transparent;
  color: var(--muted-foreground);
  font-size: 0.875rem;
  line-height: 1.65;
}

.welcome-block :deep(.md-editor-preview p) {
  margin: 0.35rem 0;
}

.welcome-block :deep(.md-editor-preview p:first-child) {
  margin-top: 0;
}

.welcome-block :deep(.md-editor-preview p:last-child) {
  margin-bottom: 0;
}

.welcome-block :deep(.md-editor-preview ul),
.welcome-block :deep(.md-editor-preview ol) {
  margin: 0.4rem 0;
  padding-left: 1.25rem;
}

.welcome-block :deep(.md-editor-preview ul) {
  list-style: disc;
}

.welcome-block :deep(.md-editor-preview ol) {
  list-style: decimal;
}

.welcome-block :deep(.md-editor-preview img) {
  max-width: 100%;
  border-radius: 8px;
}
</style>
