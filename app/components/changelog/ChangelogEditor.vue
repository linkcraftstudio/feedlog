<script setup lang="ts">
import { NormalToolbar } from 'md-editor-v3'
import '~/assets/css/md-editor-preview.css'
import { sanitizeAttachmentHtml, resolveAttachmentUrl } from '~/utils/attachment'
import { toast } from 'vue-sonner'

const props = defineProps<{
  changelogId?: string
}>()

const emit = defineEmits<{
  saved: [changelog: ChangelogAdminDetail]
  deleted: []
}>()

const { onUploadImg } = useUploadImg()
const { confirm } = useConfirmDialog()
const { t } = useI18n()
const localePath = useLocalePath()

const categoryLabel = computed<Record<string, string>>(() => ({
  new: t('changelog.category.new'),
  improved: t('changelog.category.improved'),
  fixed: t('changelog.category.fixed'),
}))

const isCreateMode = computed(() => !props.changelogId)
const loading = ref(false)
const saving = ref(false)
const publishing = ref(false)
const deleting = ref(false)

const localTitle = ref('')
const localContent = ref('')
const localCategories = ref<ChangelogCategory[]>([])
const localHasCover = ref(false)
const localCoverUrl = ref<string | null>(null)
const localStatus = ref<string>('draft')
const localSlug = ref<string | null>(null)
const localPublishedAt = ref<string | null>(null)

const showAiModal = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

// Snapshot for dirty detection (must be reactive so isDirty re-evaluates on snapshot change)
const snapshot = ref({ title: '', content: '', categories: '[]', cover: null as string | null })

function takeSnapshot() {
  snapshot.value = {
    title: localTitle.value,
    content: localContent.value,
    categories: JSON.stringify(localCategories.value),
    cover: localCoverUrl.value,
  }
}

const isDirty = computed(() =>
  localTitle.value !== snapshot.value.title
  || localContent.value !== snapshot.value.content
  || JSON.stringify(localCategories.value) !== snapshot.value.categories
  || localCoverUrl.value !== snapshot.value.cover,
)

// Load existing changelog in edit mode
if (props.changelogId) {
  loading.value = true
  try {
    const data = await useApiFetch<ChangelogAdminDetail>(`/api/admin/changelogs/${props.changelogId}`)
    localTitle.value = data.title
    localContent.value = data.content
    localCategories.value = (data.categories ?? []) as ChangelogCategory[]
    localCoverUrl.value = data.cover
    localHasCover.value = !!data.cover
    localStatus.value = data.status
    localSlug.value = data.slug
    localPublishedAt.value = data.publishedAt
    takeSnapshot()
  } catch {
    toast.error(t('changelog.editor.loadFailed'))
  } finally {
    loading.value = false
  }
}

const coverUploading = ref(false)
// Blob URL for local preview while uploading
const coverPreviewBlob = ref<string | null>(null)

async function handleFileChange(e: Event) {
  const target = e.target as HTMLInputElement
  if (!target.files || target.files.length === 0) return
  const file = target.files[0]

  // Show local blob preview immediately
  coverPreviewBlob.value = URL.createObjectURL(file)
  localHasCover.value = true
  coverUploading.value = true

  try {
    const formData = new FormData()
    formData.append('file', file)
    const result = await $fetch<{ key: string }>('/api/upload', {
      method: 'POST',
      body: formData,
    })
    // Store only the key (e.g. "uploads/img.png"), no prefix
    localCoverUrl.value = result.key
    coverPreviewBlob.value = null
  } catch {
    // Upload failed — revert
    localHasCover.value = false
    localCoverUrl.value = null
    coverPreviewBlob.value = null
  } finally {
    coverUploading.value = false
  }
}

function handleRemoveCover(e: Event) {
  e.stopPropagation()
  localHasCover.value = false
  localCoverUrl.value = null
  if (fileInput.value) fileInput.value.value = ''
}

// Blob preview during upload, otherwise resolve key to /api/files/ path
const coverPreviewUrl = computed(() => coverPreviewBlob.value ?? resolveAttachmentUrl(localCoverUrl.value))

function triggerUpload() {
  if (fileInput.value) fileInput.value.click()
}

function toggleType(type: ChangelogCategory) {
  if (localCategories.value.includes(type)) {
    localCategories.value = localCategories.value.filter(t => t !== type)
  } else {
    localCategories.value.push(type)
  }
}

function typeToggleClass(type: ChangelogCategory, isActive: boolean) {
  if (!isActive) return 'border-border bg-background text-muted-foreground hover:bg-muted'
  if (type === 'new') return 'border-primary/25 bg-primary/10 text-primary'
  if (type === 'improved') return 'border-chart-2/25 bg-chart-2/10 text-chart-2'
  return 'border-success/25 bg-success/10 text-success'
}

function typeIcon(type: ChangelogCategory) {
  if (type === 'new') return 'lucide:sparkles'
  if (type === 'improved') return 'lucide:zap'
  return 'lucide:wrench'
}

function statusLabel(status: string) {
  return t(`changelog.admin.status.${status}`)
}

async function handleSave() {
  if (!localTitle.value.trim() || !localContent.value.trim()) {
    toast.error(t('changelog.editor.titleContentRequired'))
    return
  }
  saving.value = true

  try {
    const body = {
      title: localTitle.value.trim(),
      content: localContent.value,
      categories: localCategories.value,
      cover: localCoverUrl.value,
    }

    let data: ChangelogAdminDetail
    if (isCreateMode.value) {
      data = await useApiFetch<ChangelogAdminDetail>('/api/admin/changelogs', {
        method: 'POST',
        body,
      })
      takeSnapshot() // Clear dirty before navigation
      navigateTo(localePath(`/dashboard/changelog/${data.id}`))
    } else {
      data = await useApiFetch<ChangelogAdminDetail>(`/api/admin/changelogs/${props.changelogId}`, {
        method: 'PATCH',
        body,
      })
      localStatus.value = data.status
      takeSnapshot()
      emit('saved', data)
    }
  } catch (e: any) {
    toast.error(e?.data?.message || t('changelog.editor.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function handlePublish() {
  if (!localTitle.value.trim() || !localContent.value.trim()) {
    toast.error(t('changelog.editor.titleContentRequiredPublish'))
    return
  }
  publishing.value = true

  try {
    // Save first
    if (!isCreateMode.value) {
      await useApiFetch(`/api/admin/changelogs/${props.changelogId}`, {
        method: 'PATCH',
        body: {
          title: localTitle.value.trim(),
          content: localContent.value,
          categories: localCategories.value,
          cover: localCoverUrl.value,
        },
      })
    }

    const data = await useApiFetch<ChangelogAdminDetail>(`/api/admin/changelogs/${props.changelogId}/publish`, {
      method: 'POST',
    })
    localStatus.value = data.status
    localSlug.value = data.slug
    localPublishedAt.value = data.publishedAt
    takeSnapshot()
    emit('saved', data)
    toast.success(t('changelog.editor.publishSuccess'))
  } catch (e: any) {
    toast.error(e?.data?.message || t('changelog.editor.publishFailed'))
  } finally {
    publishing.value = false
  }
}

async function handleDelete() {
  const ok = await confirm({
    title: t('changelog.editor.deleteTitle'),
    description: t('changelog.editor.deleteDescription'),
    confirmText: t('common.delete'),
    variant: 'destructive',
  })
  if (!ok) return
  deleting.value = true

  try {
    await useApiFetch(`/api/admin/changelogs/${props.changelogId}`, { method: 'DELETE' })
    takeSnapshot() // Clear dirty state before navigation
    emit('deleted')
    navigateTo(localePath('/dashboard/changelog'))
  } catch (e: any) {
    toast.error(e?.data?.message || t('changelog.editor.deleteFailed'))
  } finally {
    deleting.value = false
  }
}

// --- Unsaved changes guard ---

// Browser tab close / refresh
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (isDirty.value) {
    e.preventDefault()
  }
}

onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload))

// In-app route navigation
const router = useRouter()
let removeGuard: (() => void) | null = null

onMounted(() => {
  removeGuard = router.beforeEach(async (to, from) => {
    if (!isDirty.value) return true
    const ok = await confirm({
      title: t('changelog.editor.unsavedTitle'),
      description: t('changelog.editor.unsavedDescription'),
      confirmText: t('changelog.editor.leave'),
      cancelText: t('changelog.editor.stay'),
      variant: 'destructive',
    })
    return ok
  })
})

onBeforeUnmount(() => removeGuard?.())

function handleAiApply(result: ChangelogAiResult) {
  localTitle.value = result.title
  localContent.value = result.content
  localCategories.value = result.categories as ChangelogCategory[]
  showAiModal.value = false
}
</script>

<template>
  <div v-if="loading" class="flex items-center justify-center py-16">
    <div class="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" />
  </div>

  <div v-else class="flex h-full min-h-0 flex-col bg-background">
    <!-- Header -->
    <header class="flex h-16 shrink-0 items-center justify-between border-b border-border bg-card px-6">
      <div class="flex items-center gap-4">
        <NuxtLink
          :to="localePath('/dashboard/changelog')"
          class="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <Icon name="lucide:arrow-left" size="16" />
          {{ $t('changelog.editor.back') }}
        </NuxtLink>
        <div class="h-4 w-px bg-border" />
        <div v-if="!isCreateMode" class="flex items-center gap-2 text-sm font-medium text-foreground/80">
          <Icon name="lucide:check-circle-2" size="16" class="text-success" />
          {{ statusLabel(localStatus) }}
        </div>
        <a
          v-if="localStatus === 'published' && localSlug"
          :href="`/changelog/${localSlug}`"
          target="_blank"
          class="inline-flex items-center gap-1 text-sm font-medium text-primary hover:text-primary/80 transition-colors"
        >
          {{ $t('changelog.editor.view') }}
          <Icon name="lucide:external-link" size="14" />
        </a>
      </div>
      <div class="flex items-center gap-3">
        <button
          v-if="!isCreateMode"
          type="button"
          class="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground shadow-sm transition-colors hover:border-destructive hover:bg-destructive hover:text-destructive-foreground"
          :title="$t('common.delete')"
          :disabled="deleting"
          @click="handleDelete"
        >
          <Icon name="lucide:trash-2" size="16" />
        </button>
        <button
          type="button"
          class="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-4 text-sm font-semibold text-foreground shadow-sm transition-colors hover:bg-muted"
          :disabled="saving || coverUploading"
          @click="handleSave"
        >
          <Icon v-if="saving" name="lucide:loader-2" size="14" class="animate-spin" />
          <Icon v-else name="lucide:save" size="14" />
          {{ $t('common.save') }}
        </button>
        <button
          v-if="!isCreateMode"
          type="button"
          class="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
          :disabled="publishing || coverUploading"
          @click="handlePublish"
        >
          <Icon v-if="publishing" name="lucide:loader-2" size="14" class="animate-spin" />
          <Icon v-else name="lucide:send" size="14" />
          {{ $t('changelog.editor.publish') }}
        </button>
      </div>
    </header>

    <!-- Editor Container: left details col + right body col -->
    <div class="flex flex-1 flex-col min-h-0 overflow-y-auto bg-muted/10 lg:flex-row lg:overflow-hidden">

      <!-- Left: Details (scrollable) -->
      <div class="flex w-full shrink-0 flex-col gap-6 border-b border-border p-6 lg:w-[400px] lg:overflow-y-auto lg:border-b-0 lg:border-r xl:w-[460px]">
        <h2 class="shrink-0 text-xl font-bold text-foreground">{{ $t('changelog.editor.details') }}</h2>

        <!-- Featured Image -->
        <section class="shrink-0 rounded-xl border border-border bg-card p-5 shadow-sm">
          <h3 class="mb-3 text-sm font-semibold text-foreground">{{ $t('changelog.editor.featuredImage') }}</h3>
          <div class="relative">
            <button
              class="group flex h-28 w-full flex-col items-center justify-center gap-2.5 rounded-lg border-2 border-dashed border-border bg-muted/30 transition-colors hover:border-primary/50 hover:bg-muted/50"
              @click="triggerUpload"
            >
              <template v-if="localHasCover && (localCoverUrl || coverPreviewBlob)">
                <img :src="coverPreviewUrl!" class="absolute inset-0 h-full w-full rounded-lg object-cover" :alt="$t('a11y.coverImage')" >
                <!-- Upload loading overlay -->
                <div v-if="coverUploading" class="absolute inset-0 flex flex-col items-center justify-center rounded-lg bg-black/50">
                  <div class="animate-spin w-6 h-6 border-2 border-white border-t-transparent rounded-full" />
                  <span class="mt-2 text-xs font-medium text-white">{{ $t('changelog.editor.uploading') }}</span>
                </div>
                <!-- Hover replace overlay (only when not uploading) -->
                <div v-else class="absolute inset-0 flex flex-col items-center justify-center rounded-lg bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                  <div class="flex h-10 w-10 items-center justify-center rounded-full bg-background/90 shadow-sm">
                    <Icon name="lucide:upload-cloud" size="18" class="text-foreground" />
                  </div>
                  <span class="mt-2 text-xs font-medium text-white">{{ $t('changelog.editor.clickReplace') }}</span>
                </div>
              </template>
              <template v-else>
                <div class="flex h-10 w-10 items-center justify-center rounded-full bg-background shadow-sm transition-colors group-hover:bg-card">
                  <Icon name="lucide:upload-cloud" size="20" class="text-muted-foreground" />
                </div>
                <span class="text-xs font-medium text-muted-foreground group-hover:text-foreground">
                  {{ $t('changelog.editor.clickUpload') }}
                </span>
                <span class="text-[11px] text-muted-foreground/60">
                  {{ $t('changelog.editor.coverHint') }}
                </span>
              </template>
            </button>
            <button
              v-if="localHasCover"
              type="button"
              class="absolute right-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-black/50 text-white transition-colors hover:bg-black/70"
              @click="handleRemoveCover"
            >
              <Icon name="lucide:x" size="14" />
            </button>
            <input
              ref="fileInput"
              type="file"
              accept="image/*"
              class="hidden"
              @change="handleFileChange"
            >
          </div>
        </section>

        <!-- Title & Types -->
        <section class="shrink-0 rounded-xl border border-border bg-card p-5 shadow-sm">
          <div class="grid gap-6">
            <div>
              <label class="mb-2 block text-sm font-semibold text-foreground">{{ $t('changelog.editor.titleLabel') }}</label>
              <input
                v-model="localTitle"
                maxlength="70"
                :placeholder="$t('changelog.editor.titlePlaceholder')"
                class="h-10 w-full rounded-lg border border-border bg-muted/30 px-3 text-sm outline-none transition-colors focus:border-primary focus:bg-background focus:ring-1 focus:ring-primary/30"
              >
            </div>
            <div>
              <label class="mb-2 block text-sm font-semibold text-foreground">{{ $t('changelog.editor.types') }}</label>
              <div class="flex flex-wrap gap-2">
                <button
                  v-for="type in (['new', 'improved', 'fixed'] as ChangelogCategory[])"
                  :key="type"
                  class="inline-flex h-8 items-center gap-1.5 rounded-full border px-4 text-xs font-bold capitalize transition-colors"
                  :class="typeToggleClass(type, localCategories.includes(type))"
                  @click="toggleType(type)"
                >
                  <Icon :name="typeIcon(type)" size="12" />
                  {{ categoryLabel[type] ?? type }}
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>

      <!-- Right: Body (fills height, editor stretches) -->
      <div class="flex min-h-[480px] min-w-0 flex-1 flex-col p-6 lg:min-h-0 lg:pb-6">
        <div class="mb-4 flex shrink-0 items-center justify-between">
          <h2 class="text-xl font-bold text-foreground">{{ $t('changelog.editor.content') }}</h2>
        </div>

        <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
          <ClientOnly>
            <div class="editor-preview-styled min-h-0 flex-1 overflow-hidden [&_.md-editor]:rounded-lg [&_.md-editor]:border-transparent [&_.md-editor]:shadow-[0_0_0_1px_rgba(0,0,0,0.08)] dark:[&_.md-editor]:shadow-[0_0_0_1px_rgba(255,255,255,0.1)]">
              <ThemedMdEditor
                v-model="localContent"
                language="en-US"
                :placeholder="$t('changelog.editor.contentPlaceholder')"
                :preview="false"
                :max-length="20000"
                :footers="['markdownTotal']"
                :toolbars="['bold', 'italic', 'strikeThrough', '-', 'title', 'unorderedList', 'orderedList', '-', 'link', 'image', 'code', 'codeRow', '-', 'previewOnly', '=', 0]"
                :sanitize="sanitizeAttachmentHtml"
                style="height: 100%"
                @on-upload-img="onUploadImg"
              >
                <template #defToolbars>
                  <NormalToolbar :title="$t('changelog.editor.aiWrite')" @on-click="showAiModal = true">
                    <template #trigger>
                      <div class="inline-flex h-7 items-center gap-1.5 rounded-md border border-purple-200 bg-purple-50 px-2.5 text-xs font-bold text-purple-600 transition-colors hover:bg-purple-100 dark:border-purple-500/30 dark:bg-purple-500/20 dark:text-purple-400">
                        <Icon name="lucide:wand-2" size="14" />
                        {{ $t('changelog.editor.aiWrite') }}
                      </div>
                    </template>
                  </NormalToolbar>
                </template>
              </ThemedMdEditor>
            </div>
          </ClientOnly>
        </div>
      </div>

    </div>
  </div>

  <!-- AI Modal -->
  <ChangelogAiModal
    :open="showAiModal"
    @apply="handleAiApply"
    @close="showAiModal = false"
  />
</template>
