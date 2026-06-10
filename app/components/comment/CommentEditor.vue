<script setup lang="ts">
import { sanitizeAttachmentHtml } from '~/utils/attachment'

const props = withDefaults(defineProps<{
  parentId?: string
  replyToId?: string
  placeholder?: string
  initialContent?: string
  loading?: boolean
}>(), {
  loading: false,
})

const emit = defineEmits<{
  submit: [content: string]
  cancel: []
}>()

const content = ref(props.initialContent ?? '')
const error = ref('')

const isReply = computed(() => !!props.parentId)
const isEditing = computed(() => !!props.initialContent)

const { onUploadImg } = useUploadImg()

// Footer: '=' pushes slot content to the right, 0 = first defFooters child
const footers = ['=', 0] as const

function handleSubmit() {
  const text = content.value.trim()
  if (!text) return
  emit('submit', text)
}

function clear() {
  content.value = ''
  error.value = ''
}

defineExpose({ clear })
</script>

<template>
  <div class="comment-editor">
    <ThemedMdEditor
      v-model="content"
      language="en-US"
      :placeholder="placeholder || (isReply ? 'Write a reply...' : 'Add a comment or feedback...')"
      :preview="false"
      :max-length="5000"
      :toolbars="['bold', 'italic', '-', 'link', 'unorderedList', 'code', 'codeRow', 'image']"
      :sanitize="sanitizeAttachmentHtml"
      :footers="footers"
      :style="{ height: 'auto', minHeight: isReply ? '120px' : '160px' }"
      @on-upload-img="onUploadImg"
    >
      <template #defFooters>
        <div class="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            v-if="isReply || isEditing"
            @click="$emit('cancel')"
          >
            Cancel
          </Button>
          <Button
            variant="default"
            size="sm"
            :disabled="!content.trim() || loading"
            @click="handleSubmit"
          >
            {{ isEditing ? 'Save' : (isReply ? 'Reply' : 'Comment') }}
        </Button>
        </div>
      </template>
    </ThemedMdEditor>

    <p v-if="error" class="px-4 py-2 text-sm text-destructive">{{ error }}</p>
  </div>
</template>

<style scoped>
/* Override MdEditor's monospace font to match project's body font */
.comment-editor :deep(.cm-editor),
.comment-editor :deep(.cm-editor .cm-content),
.comment-editor :deep(.cm-editor .cm-line),
.comment-editor :deep(.cm-editor .cm-placeholder) {
  font-family: var(--font-body), ui-sans-serif, system-ui, sans-serif;
}

/* Customize footer: remove top border, adjust padding for button */
.comment-editor :deep(.md-editor-footer) {
  border-block-start: none;
  height: auto;
  padding: 0 12px 8px;
  /* padding-top: 0px; */
}

/* Round the outer editor to match our container */
.comment-editor :deep(.md-editor) {
  border-radius: 12px;
  border: 1px solid var(--border);
}

/* Hide MdEditor's custom scrollbar, use browser native on CodeMirror */
.comment-editor :deep(.md-editor-custom-scrollbar__track) {
  display: none !important;
}
.comment-editor :deep(.cm-scroller) {
  overflow-y: auto !important;
  scrollbar-width: thin;
}
</style>
