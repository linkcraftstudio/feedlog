<script setup lang="ts">
import '~/assets/css/md-editor-preview.css'
import { preventShadcnDialogClose } from '~/lib/md-editor-helper';
import { sanitizeAttachmentHtml } from '~/utils/attachment';

const props = defineProps<{ defaultBoardId?: string }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ created: [slug: string] }>()

const { t, locale } = useI18n()

const boardStore = useBoardStore()
const { boards } = storeToRefs(boardStore)

const selectedBoardId = ref<string | null>(null)
const title = ref('')
const content = ref('')
const submitting = ref(false)
const error = ref('')

const { onUploadImg } = useUploadImg()

// Similar posts search
const similarPosts = ref<any[]>([])
const similarLoading = ref(false)
const similarDebounce = ref<ReturnType<typeof setTimeout>>()
// Monotonic ticket: every trigger increments it; only the run whose ticket still
// matches may write results back (out-of-order / stale-response guard).
let similarSeq = 0
const showDetailSlug = ref<string | null>(null)
const similarHintRef = ref<{ expanded: boolean } | null>(null)
const editorFocused = ref(false)

// Hint visible = loading or has results
const hintVisible = computed(() => similarLoading.value || similarPosts.value.length > 0)

// If editor has content, default to collapsed hint (don't interrupt writing)
const hintDefaultExpanded = computed(() => !content.value.trim())

function triggerSimilarSearch() {
  clearTimeout(similarDebounce.value)
  // Bump on every trigger so any in-flight request from an older query is
  // invalidated — including when this call early-returns at the 3-char gate.
  const mine = ++similarSeq
  const t = title.value.trim()
  if (t.length < 3) {
    similarPosts.value = []
    return
  }
  const delay = content.value.trim() ? 1000 : 500
  similarDebounce.value = setTimeout(async () => {
    similarLoading.value = true
    try {
      const body: Record<string, string> = { title: t }
      if (content.value.trim()) body.content = content.value.trim()
      const result = await useApiFetch<{ data: any[] }>('/api/posts/similar', { method: 'POST', body })
      // Drop if a newer query superseded us, or the modal has since closed.
      if (mine !== similarSeq || !open.value) return
      similarPosts.value = result.data
    } catch {
      if (mine === similarSeq) similarPosts.value = []
    } finally {
      if (mine === similarSeq) similarLoading.value = false
    }
  }, delay)
}

watch(title, triggerSimilarSearch)
watch(content, triggerSimilarSearch)

// Cancel any pending search if the component is torn down.
onUnmounted(() => clearTimeout(similarDebounce.value))

function reset() {
  clearTimeout(similarDebounce.value)
  similarSeq++
  similarLoading.value = false
  selectedBoardId.value = null
  title.value = ''
  content.value = ''
  error.value = ''
  similarPosts.value = []
  showDetailSlug.value = null
}

async function handleSubmit() {
  if (!selectedBoardId.value) {
    error.value = t('post.submit.errors.selectBoard')
    return
  }
  if (!title.value.trim()) {
    error.value = t('post.submit.errors.titleRequired')
    return
  }
  if (!content.value.trim()) {
    error.value = t('post.submit.errors.contentRequired')
    return
  }

  submitting.value = true
  error.value = ''

  try {
    const result = await useApiFetch<PostDetail>('/api/posts', {
      method: 'POST',
      body: {
        title: title.value,
        content: content.value,
        boardId: selectedBoardId.value,
      },
    })
    // Refresh board counts
    await boardStore.fetchBoards()
    open.value = false
    reset()
    emit('created', result.slug)
  } catch (e: any) {
    error.value = e.data?.message || t('post.submit.errors.submitFailed')
  } finally {
    submitting.value = false
  }
}

// Set default board when modal opens, reset when it closes
watch(open, (v) => {
  if (v) {
    selectedBoardId.value = props.defaultBoardId ?? boards.value[0]?.id ?? null
  } else {
    reset()
  }
})

</script>

<template>
  <!-- Keep non-modal so md-editor overlays teleported to body stay interactive -->
  <Dialog v-model:open="open" :modal="true">
    <DialogContent
      :show-close-button="false"
      @pointer-down-outside="preventShadcnDialogClose"
      @escape-key-down="preventShadcnDialogClose"
      class="!max-w-[800px] !max-h-[calc(100vh-1.5rem)] !p-0 !gap-0 !flex !flex-col overflow-hidden border-none bg-card !rounded-[24px] shadow-warm"
    >
      <!-- Close button -->
      <DialogClose class="absolute top-6 right-6 w-8 h-8 flex items-center justify-center rounded-full hover:bg-secondary transition-colors text-muted-foreground hover:text-primary z-10">
        <Icon name="lucide:x" size="20" />
      </DialogClose>

      <!-- Form content -->
      <div class="px-4 sm:px-8 md:px-12 pt-10 pb-8 flex-1 flex flex-col gap-5 min-h-0 overflow-y-auto">
        <!-- Select Board -->
        <div class="flex flex-col gap-2.5 shrink-0">
          <span class="text-xs font-bold uppercase tracking-widest text-muted-foreground">{{ $t('post.submit.selectBoard') }}</span>
          <div class="flex flex-wrap gap-2.5">
            <button
              v-for="board in boards"
              :key="board.id"
              class="px-5 py-2 rounded-full border text-[13px] font-semibold transition-all"
              :class="selectedBoardId === board.id
                ? 'bg-primary text-primary-foreground border-primary'
                : 'border-border bg-card text-muted-foreground hover:border-accent hover:text-foreground'"
              @click="selectedBoardId = selectedBoardId === board.id ? null : board.id"
            >
              {{ board.name }}
            </button>
          </div>
        </div>

        <!-- Title input -->
        <Input
          v-model="title"
          class="h-12 text-lg font-heading font-bold shrink-0"
          :placeholder="$t('post.submit.titlePlaceholder')"
          :maxlength="200"
        />

        <!-- Editor + Similar Hint: shared fixed-height container -->
        <div class="flex flex-col h-[420px] min-h-[200px] gap-2">
          <!-- Markdown editor: flex-1 shrinks when hint expands -->
          <ClientOnly>
            <div class="editor-preview-styled flex-1 min-h-[120px] transition-all duration-300">
              <ThemedMdEditor
                v-model="content"
                :language="locale === 'zh' ? 'zh-CN' : 'en-US'"
                :placeholder="$t('post.submit.bodyPlaceholder')"
                :preview="false"
                :max-length="10000"
                :toolbars="['bold', 'italic', 'strikeThrough', '-', 'title', 'unorderedList', 'orderedList', '-', 'link', 'image', 'code', 'codeRow', '-', 'previewOnly']"
                :sanitize="sanitizeAttachmentHtml"
                style="height: 100%"
                @on-upload-img="onUploadImg"
              />
            </div>
          </ClientOnly>

          <!-- Similar posts hint: shrink-0, pushes editor up -->
          <SimilarPostsHint
            ref="similarHintRef"
            :similar-posts="similarPosts"
            :loading="similarLoading"
            :default-expanded="hintDefaultExpanded"
            @select="showDetailSlug = $event.slug"
          />
        </div>

        <!-- Error message -->
        <p v-if="error" class="text-sm text-destructive shrink-0">{{ error }}</p>

        <!-- Submit button -->
        <button
          class="w-full h-11 bg-primary hover:bg-primary/90 text-primary-foreground text-[15px] font-heading font-bold rounded-[10px] transition-all transform active:scale-[0.99] shadow-lg shadow-primary/20 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          :disabled="submitting"
          @click="handleSubmit"
        >
          {{ submitting ? $t('post.submit.submitting') : $t('post.submit.submit') }}
        </button>
      </div>

      <DialogTitle class="sr-only">{{ $t('post.submit.dialogTitle') }}</DialogTitle>
      <DialogDescription class="sr-only">{{ $t('post.submit.dialogDescription') }}</DialogDescription>
    </DialogContent>
  </Dialog>

  <!-- Post detail overlay (stacked on top of submit modal) -->
  <PostDetailModal
    v-if="showDetailSlug"
    :open="!!showDetailSlug"
    :slug="showDetailSlug"
    @update:open="showDetailSlug = null"
  />
</template>

