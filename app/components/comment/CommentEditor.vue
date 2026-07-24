<script setup lang="ts">
import { sanitizeAttachmentHtml } from '~/utils/attachment'

const props = withDefaults(defineProps<{
  parentId?: string
  replyToId?: string
  placeholder?: string
  initialContent?: string
  loading?: boolean
  canNotify?: boolean
}>(), {
  loading: false,
  canNotify: false,
})

const emit = defineEmits<{
  submit: [content: string, notify: boolean]
  cancel: []
}>()

const content = ref(props.initialContent ?? '')
const error = ref('')
const notify = ref(true)

const isReply = computed(() => !!props.parentId)
const isEditing = computed(() => !!props.initialContent)
const showNotify = computed(() => props.canNotify && !isReply.value && !isEditing.value)
const submitDisabled = computed(() => !content.value.trim() || props.loading)

const { onUploadImg } = useUploadImg()

// Footer: '=' pushes slot content to the right, 0 = first defFooters child
const footers = ['=', 0] as const

function handleSubmit() {
  const text = content.value.trim()
  if (!text) return
  emit('submit', text, showNotify.value ? notify.value : true)
}

function clear() {
  content.value = ''
  error.value = ''
  notify.value = true
}

defineExpose({ clear })
</script>

<template>
  <div class="comment-editor">
    <ThemedMdEditor
      v-model="content"
      language="en-US"
      :placeholder="placeholder || (isReply ? $t('post.comment.replyPlaceholder') : $t('post.comment.addPlaceholder'))"
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
            {{ $t('common.cancel') }}
          </Button>
          <div class="flex items-center">
            <Button
              variant="default"
              size="sm"
              :class="showNotify ? 'rounded-r-none' : ''"
              :disabled="submitDisabled"
              @click="handleSubmit"
            >
              {{ isEditing ? $t('common.save') : (isReply ? $t('post.comment.reply') : $t('post.comment.comment')) }}
            </Button>
            <DropdownMenu v-if="showNotify">
              <DropdownMenuTrigger as-child>
                <Button
                  variant="default"
                  size="sm"
                  class="rounded-l-none border-l border-primary-foreground/25 px-2"
                  :disabled="submitDisabled"
                  :aria-label="$t('post.comment.emailUpvoters')"
                >
                  <Icon name="lucide:more-vertical" size="14" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" class="min-w-[240px]">
                <DropdownMenuLabel class="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                  {{ $t('post.comment.emailUpvoters') }}
                </DropdownMenuLabel>
                <!-- select.prevent: toggling must not dismiss the menu. -->
                <DropdownMenuItem
                  class="cursor-pointer gap-3 py-2"
                  :title="$t('post.comment.notifyUpvotersHint')"
                  @select.prevent="notify = !notify"
                >
                  <!-- ring: the item's accent-tinted focus background would
                       otherwise swallow the primary "on" track. -->
                  <span
                    class="relative h-5 w-9 shrink-0 rounded-full ring-1 ring-inset ring-foreground/20 transition-colors"
                    :class="notify ? 'bg-primary' : 'bg-muted'"
                  >
                    <span
                      class="absolute left-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-white shadow transition-transform"
                      :class="notify ? 'translate-x-4' : ''"
                    >
                      <Icon name="lucide:bell" size="10" class="text-muted-foreground" />
                    </span>
                  </span>
                  <span class="text-sm font-medium">{{ $t('post.comment.notifyUpvoters') }}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
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
