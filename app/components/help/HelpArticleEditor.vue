<script setup lang="ts">
import { onClickOutside, onKeyStroke } from '@vueuse/core'
import { toast } from 'vue-sonner'
import type { HelpArticleStatus, HelpCollectionIcon } from '#layers/feedlog/shared/constants/help'
import '~/assets/css/help-article.css'
import type { HelpIndexStatus } from '#layers/feedlog/shared/types/help-index'

interface ArticleDetail {
  id: string
  shortId: string
  slug: string
  title: string
  description: string | null
  content: string
  aiEnabled: boolean
  indexStatus: HelpIndexStatus | null
  status: HelpArticleStatus
  publishedAt: string | null
  createdAt: string
  updatedAt: string
  collection: { id: string; name: string; visible: boolean }
}

interface CollectionOption {
  id: string
  name: string
  icon: HelpCollectionIcon
  visible: boolean
}

const props = defineProps<{ articleId?: string; collectionId?: string }>()

const { t, locale } = useI18n()
const { confirm } = useConfirmDialog()
const { onUploadImg } = useUploadImg()
const router = useRouter()
const localePath = useLocalePath()

const id = computed(() => props.articleId ?? '')
const isNew = computed(() => !props.articleId)

const { data: article, refresh, error: loadError, status: loadStatus } = await useFetch<ArticleDetail>(() => `/api/admin/help/articles/${id.value}`, {
  immediate: !isNew.value,
})

watch(isNew, (value) => { if (!value) refresh() })
const { data: indexState, refresh: refreshIndex } = await useFetch<{ status: HelpIndexStatus; enabled: boolean; errorCode: string | null }>(() => `/api/admin/help/articles/${id.value}/index-status`, { immediate: !isNew.value })
let indexPoll: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  indexPoll = setInterval(() => {
    if (id.value && indexState.value?.enabled && indexState.value.status === 'indexing') refreshIndex()
  }, 5000)
})
onBeforeUnmount(() => clearInterval(indexPoll))
watch(() => article.value?.updatedAt, () => { if (id.value) refreshIndex() })
const { data: collectionsData } = await useFetch<{ data: CollectionOption[] }>('/api/admin/help/collections', {
  query: { flat: 1 },
})
const collections = computed(() => collectionsData.value?.data ?? [])

const TITLE_MAX_LENGTH = 200
const form = reactive({ title: '', description: '', content: '', aiEnabled: true })
const draftCollectionId = ref(props.collectionId ?? '')
const saving = ref(false)
const titleInput = ref<HTMLInputElement | null>(null)
const bodyField = ref<HTMLElement | null>(null)
const errors = reactive({ title: false, content: false })
watch(() => form.title, () => { errors.title = false })
watch(() => form.content, () => { errors.content = false })
const pickerOpen = ref(false)
const pickerRef = ref<HTMLElement | null>(null)
onClickOutside(pickerRef, () => { pickerOpen.value = false })
onKeyStroke('Escape', () => { pickerOpen.value = false; previewOpen.value = false })
const previewOpen = ref(false)
const leavingAfterWrite = ref(false)

function syncForm() {
  form.title = article.value?.title ?? ''
  form.description = article.value?.description ?? ''
  form.content = article.value?.content ?? ''
  form.aiEnabled = article.value?.aiEnabled ?? true
}
syncForm()
watch(() => article.value?.id, syncForm)

const dirty = computed(() =>
  form.title !== (article.value?.title ?? '')
  || form.description !== (article.value?.description ?? '')
  || form.content !== (article.value?.content ?? '')
  || form.aiEnabled !== (article.value?.aiEnabled ?? true))

const canSave = computed(() => isNew.value || dirty.value || (article.value?.status === 'published' && indexState.value?.enabled && ['not_indexed', 'failed'].includes(indexState.value.status)))

const collection = computed(() => isNew.value
  ? collections.value.find(c => c.id === draftCollectionId.value)
  : article.value?.collection)
const articleUrl = computed(() => article.value ? `/help/${article.value.shortId}-${article.value.slug}` : '')

watch(collections, (list) => {
  if (isNew.value && !draftCollectionId.value) draftCollectionId.value = list[0]?.id ?? ''
}, { immediate: true })

function formatStamp(iso: string | null | undefined) {
  if (!iso) return '—'
  return new Intl.DateTimeFormat(locale.value, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
}

async function patch(body: Record<string, unknown>) {
  if (saving.value) return false
  const submitted = { ...form }
  saving.value = true
  try {
    const saved = await $fetch<ArticleDetail>(`/api/admin/help/articles/${id.value}`, { method: 'PATCH', body })
    article.value = saved
    // The save response already describes the queued generation; show it immediately.
    if (indexState.value) indexState.value = { ...indexState.value, enabled: saved.indexStatus !== null, status: saved.indexStatus ?? 'not_indexed' }
    // Apply server normalization only to submitted fields not edited in flight.
    // Moving collections must not discard unrelated unsaved content.
    if (article.value) {
      for (const key of ['title', 'description', 'content'] as const) {
        if (key in body && form[key] === submitted[key]) form[key] = article.value[key] ?? ''
      }
      if ('aiEnabled' in body && form.aiEnabled === submitted.aiEnabled) form.aiEnabled = article.value.aiEnabled
    }
    return true
  }
  catch (e) {
    toast.error((e as { data?: { message?: string } }).data?.message || t('help.admin.editor.saveFailed'))
    return false
  }
  finally {
    saving.value = false
  }
}

const contentBody = () => ({
  title: form.title.trim(),
  description: form.description.trim() || null,
  content: form.content,
  aiEnabled: form.aiEnabled,
})

async function create(publish: boolean) {
  if (saving.value) return
  if (!draftCollectionId.value) {
    toast.error(t('help.admin.newArticleDisabledHint'))
    return
  }

  saving.value = true
  try {
    const created = await $fetch<{ id: string }>('/api/admin/help/articles', {
      method: 'POST',
      body: { collectionId: draftCollectionId.value, ...contentBody(), publish },
    })
    toast.success(t('help.admin.editor.saved'))
    leavingAfterWrite.value = true
    await router.replace(localePath(`/dashboard/help/${created.id}`))
  }
  catch (e) {
    toast.error((e as { data?: { message?: string } }).data?.message || t('help.admin.editor.saveFailed'))
  }
  finally {
    saving.value = false
  }
}

function validateContent() {
  errors.title = !form.title.trim()
  errors.content = !form.content.trim()
  if (errors.title) titleInput.value?.focus()
  else if (errors.content) bodyField.value?.querySelector<HTMLElement>('[contenteditable="true"]')?.focus()
  return !errors.title && !errors.content
}

async function saveDraft() {
  if (saving.value || !canSave.value || !validateContent()) return
  if (isNew.value) return create(false)
  if (await patch(contentBody())) toast.success(t('help.admin.editor.saved'))
}

async function togglePublish() {
  if (saving.value) return
  if (article.value?.status === 'published') {
    const ok = await confirm({
      title: t('help.admin.editor.unpublishTitle'),
      description: t('help.admin.editor.unpublishBody'),
      confirmText: t('help.admin.unpublish'), cancelText: t('common.cancel'),
    })
    if (ok && await patch({ status: 'archived' })) toast.success(t('help.admin.editor.saved'))
    return
  }
  if (!validateContent()) return
  const ok = await confirm({
    title: t('help.admin.publishTitle'),
    description: t('help.admin.editor.publishBody'),
    confirmText: t('help.admin.publish'), cancelText: t('common.cancel'),
  })
  if (!ok) return
  if (isNew.value) return create(true)
  if (await patch({ ...contentBody(), status: 'published' })) toast.success(t('help.admin.editor.saved'))
}

onKeyStroke('s', (event) => {
  if (!(event.ctrlKey || event.metaKey)) return
  event.preventDefault()
  if (!saving.value) void saveDraft()
})

async function pickCollection(collectionId: string) {
  if (saving.value) return
  pickerOpen.value = false
  if (isNew.value) {
    draftCollectionId.value = collectionId
    return
  }
  if (collectionId === collection.value?.id) return

  await patch({ collectionId })
}

async function removeArticle() {
  if (saving.value || !article.value) return

  const ok = await confirm({
    title: t('help.admin.editor.deleteTitle', { title: article.value.title }),
    description: t('help.admin.editor.deleteDescription'),
    confirmText: t('common.delete'),
    cancelText: t('common.cancel'),
    variant: 'destructive',
  })
  if (!ok) return

  saving.value = true
  try {
    await $fetch(`/api/admin/help/articles/${id.value}`, { method: 'DELETE' })
    toast.success(t('help.admin.editor.deleted'))
    leavingAfterWrite.value = true
    await router.push(localePath('/dashboard/help'))
  }
  catch (e) {
    toast.error((e as { data?: { message?: string } }).data?.message || t('help.admin.editor.deleteFailed'))
  }
  finally {
    saving.value = false
  }
}

async function copyUrl() {
  await navigator.clipboard.writeText(`${location.origin}${articleUrl.value}`)
  toast.success(t('help.admin.editor.copied'))
}

onBeforeRouteLeave(async () => {
  if (leavingAfterWrite.value) return true
  if (!dirty.value && !(isNew.value && (form.title || form.content))) return true
  return await confirm({
    title: t('help.admin.editor.leaveTitle'),
    description: t('help.admin.editor.leaveBody'),
    confirmText: t('help.admin.editor.leaveDiscard'),
    cancelText: t('help.admin.editor.leaveKeep'),
    variant: 'destructive',
  })
})

function warnBeforeUnload(event: BeforeUnloadEvent) {
  if (!dirty.value || leavingAfterWrite.value) return
  event.preventDefault()
  event.returnValue = ''
}
onMounted(() => window.addEventListener('beforeunload', warnBeforeUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', warnBeforeUnload))

function goBack() {
  router.push(localePath('/dashboard/help'))
}
</script>

<template>
  <div v-if="article || isNew" class="flex h-full min-h-0 flex-col">
    <header class="flex min-h-16 shrink-0 flex-wrap items-center justify-between gap-3 py-3 border-b border-border bg-card px-6">
      <div class="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <button type="button" data-testid="help-editor-back" class="inline-flex items-center gap-2 text-xs font-bold text-muted-foreground hover:text-foreground" @click="goBack">
          <Icon name="lucide:arrow-left" size="16" />
          {{ $t('help.admin.editor.back') }}
        </button>
        <div class="h-4 w-px bg-border" />
        <HelpStatusBadge v-if="article" :status="article.status" />
        <HelpIndexStatusBadge v-if="article?.status === 'published' && indexState?.enabled && indexState.status !== 'ready'" :status="indexState.status" />
        <span class="text-xs" :class="dirty ? 'font-bold text-[var(--accent)]' : 'font-medium text-muted-foreground'">
          {{ !article
            ? $t('help.admin.editor.notSaved')
            : dirty ? $t('help.admin.editor.unsaved') : $t('help.admin.editor.lastSaved', { at: formatStamp(article.updatedAt) }) }}
        </span>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <button
          v-if="article"
          type="button"
          class="inline-flex h-9 items-center gap-1.5 rounded-2xl border border-destructive/40 px-3 text-xs font-bold text-destructive hover:bg-destructive/10 disabled:opacity-50"
          :disabled="saving"
          @click="removeArticle"
        >
          <Icon name="lucide:trash-2" size="14" />
          {{ $t('help.admin.editor.delete') }}
        </button>
        <div v-if="article" class="h-4 w-px bg-border" />
        <button type="button" class="inline-flex h-9 items-center gap-2 rounded-2xl border border-border bg-background px-3 text-xs font-bold text-muted-foreground hover:text-foreground" @click="previewOpen = true">
          <Icon name="lucide:eye" size="16" />
          {{ $t('help.admin.editor.preview') }}
        </button>
        <button type="button" class="inline-flex h-9 items-center gap-2 rounded-2xl border border-border bg-background px-3 text-xs font-bold text-muted-foreground hover:text-foreground disabled:opacity-50" :disabled="saving || !canSave" @click="saveDraft">
          <Icon name="lucide:save" size="16" />
          {{ saving ? $t('help.admin.editor.saving') : article?.status === 'published' ? $t('help.admin.editor.saveChanges') : $t('help.admin.editor.saveDraft') }}
        </button>
        <button type="button" class="inline-flex h-9 items-center rounded-2xl border border-primary bg-primary px-4 text-xs font-bold text-primary-foreground hover:bg-primary/90 disabled:opacity-50" :disabled="saving" @click="togglePublish">
          {{ article?.status === 'published' ? $t('help.admin.unpublish') : $t('help.admin.publish') }}
        </button>
      </div>
    </header>

    <div class="flex min-h-0 flex-1 flex-col overflow-auto lg:flex-row lg:overflow-hidden">
      <div class="help-editor-workspace min-w-0 flex-1 px-5 py-5 lg:overflow-auto lg:px-8 lg:py-6">
        <div class="help-editor-form mx-auto w-full max-w-[1280px]">
          <p v-if="isNew && !collections.length" class="mb-4 text-sm text-destructive">{{ $t('help.admin.newArticleDisabledHint') }}</p>
          <p class="mb-1.5 text-[11px] font-bold uppercase leading-[17px] tracking-[.05em] text-muted-foreground">
            {{ $t('help.admin.editor.title') }}<span aria-hidden="true" class="ml-0.5 text-destructive">*</span>
          </p>
          <input
            ref="titleInput"
            v-model="form.title"
            :aria-label="$t('help.admin.editor.title')"
            :aria-invalid="errors.title"
            aria-describedby="help-title-error"
            :disabled="isNew && saving"
            type="text"
            required
            :maxlength="TITLE_MAX_LENGTH"
            class="w-full border-0 border-b border-border bg-transparent pb-3 text-[26px] font-bold leading-[34px]! tracking-[-.01em] outline-none"
            :placeholder="$t('help.admin.editor.titlePlaceholder')"
          >

          <p v-if="errors.title" id="help-title-error" role="alert" class="mt-2 text-xs text-destructive">{{ $t('help.admin.editor.titleRequired') }}</p>
          <p class="mt-1 text-right text-xs text-muted-foreground">{{ form.title.length }} / {{ TITLE_MAX_LENGTH }}</p>

          <p class="mb-1.5 mt-3 text-[11px] font-bold uppercase leading-[17px] tracking-[.05em] text-muted-foreground">{{ $t('help.admin.editor.description') }}</p>
          <textarea
            v-model="form.description"
            :aria-label="$t('help.admin.editor.description')"
            :disabled="isNew && saving"
            maxlength="300"
            class="min-h-[44px] w-full resize-none border-0 border-b border-border bg-transparent pb-3 text-sm leading-[22px] outline-none"
            :placeholder="$t('help.admin.editor.descriptionPlaceholder')"
          />

          <p class="mt-1 text-right text-xs text-muted-foreground">{{ form.description.length }} / 300</p>
          <p class="mb-2.5 mt-3 text-[11px] font-bold uppercase leading-[17px] tracking-[.05em] text-muted-foreground">
            {{ $t('help.admin.editor.body') }}<span aria-hidden="true" class="ml-0.5 text-destructive">*</span>
          </p>
          <div ref="bodyField" class="help-editor-body help-article-styled">
            <ClientOnly>
              <ThemedMdEditor
                v-model="form.content"
                :read-only="isNew && saving"
                :language="locale === 'zh' ? 'zh-CN' : 'en-US'"
                :placeholder="$t('help.admin.editor.bodyPlaceholder')"
                :preview="false"
                :footers="['markdownTotal']"
                :toolbars="['bold', 'italic', 'strikeThrough', '-', 'title', 'unorderedList', 'orderedList', '-', 'link', 'image', 'code', 'codeRow', 'table', '=', 0]"
                class="help-editor-input"
                @on-upload-img="onUploadImg"
              />
            </ClientOnly>
            <p v-if="errors.content" role="alert" class="mt-2 text-xs text-destructive">{{ $t('help.admin.editor.contentRequired') }}</p>
          </div>
        </div>
      </div>

      <aside class="flex w-full shrink-0 flex-col gap-[22px] border-t border-border bg-card px-5 py-6 lg:w-[300px] lg:basis-[300px] lg:overflow-auto lg:border-l lg:border-t-0">
        <div>
          <p class="mb-1.5 text-[11px] font-bold uppercase leading-[17px] tracking-[.05em] text-muted-foreground">{{ $t('help.admin.editor.collection') }}</p>
          <div ref="pickerRef" class="relative">
            <div
              class="flex h-9 cursor-pointer items-center justify-between rounded-lg border border-border bg-card px-3 text-[13px] font-semibold leading-[18px]"
              @click="pickerOpen = !pickerOpen"
            >
              {{ collection?.name }}
              <Icon name="lucide:chevron-down" size="14" class="text-muted-foreground" />
            </div>
            <div v-if="pickerOpen" class="absolute inset-x-0 top-10 z-20 overflow-hidden rounded-lg border border-border bg-card shadow-[0_12px_32px_rgba(0,0,0,.12)]">
              <div
                v-for="option in collections"
                :key="option.id"
                class="flex cursor-pointer items-center gap-2.5 px-3 py-[9px] hover:bg-secondary"
                @click="pickCollection(option.id)"
              >
                <span class="flex text-primary"><Icon :name="`lucide:${option.icon}`" size="15" /></span>
                <span class="min-w-0 flex-1 truncate text-[13px] font-semibold">{{ option.name }}</span>
                <Icon v-if="option.id === collection?.id" name="lucide:check" size="14" class="text-primary" />
              </div>
            </div>
          </div>
        </div>

        <div class="flex items-start gap-3 rounded-md border border-border bg-background px-3.5 py-3">
          <div class="min-w-0 flex-1">
            <label for="allow-ai" class="text-[13px] font-bold leading-[18px]">{{ $t('help.admin.aiUsage') }}</label>
            <p class="mt-0.5 text-xs leading-[17px] text-muted-foreground">{{ $t('help.admin.aiUsageHint') }}</p>
          </div>
          <Switch id="allow-ai" v-model="form.aiEnabled" :disabled="isNew && saving" />
        </div>

        <div>
          <p class="mb-1.5 text-[11px] font-bold uppercase leading-[17px] tracking-[.05em] text-muted-foreground">{{ $t('help.admin.editor.details') }}</p>
          <div class="flex justify-between py-1 text-xs">
            <span class="text-muted-foreground">{{ $t('help.admin.editor.created') }}</span>
            <b>{{ article ? formatStamp(article.createdAt) : '—' }}</b>
          </div>
          <div class="flex justify-between py-1 text-xs">
            <span class="text-muted-foreground">{{ $t('help.admin.editor.updated') }}</span>
            <b>{{ article ? formatStamp(article.updatedAt) : '—' }}</b>
          </div>
          <div class="mt-2.5 flex justify-between py-1 text-xs">
            <span class="text-muted-foreground">{{ $t('help.admin.editor.articleUrl') }}</span>
          </div>
          <p v-if="isNew" class="mt-1.5 text-[11px] leading-4 text-muted-foreground">{{ $t('help.admin.editor.urlPending') }}</p>
          <p v-else-if="article?.status !== 'published'" class="mt-1.5 text-xs text-muted-foreground">{{ $t('help.admin.editor.linkNotPublic') }}</p>
          <div v-if="!isNew" class="mt-1.5 flex items-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1.5">
            <code class="min-w-0 flex-1 truncate text-[11px]">{{ articleUrl }}</code>
            <button type="button" class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground" @click="copyUrl">
              <Icon name="lucide:link" size="13" />
            </button>
          </div>
        </div>
      </aside>
    </div>

    <div v-if="previewOpen" class="fixed inset-0 z-[60] flex justify-center bg-[rgba(40,40,40,.3)] pt-9" @click="previewOpen = false">
      <div class="flex max-h-full w-[1080px] max-w-full flex-col overflow-hidden rounded-t-2xl border border-b-0 border-border bg-background" @click.stop>
        <div class="flex h-[46px] shrink-0 items-center justify-between border-b border-border bg-card px-5">
          <span class="flex items-center gap-2 text-xs font-bold leading-4 text-muted-foreground">
            <Icon name="lucide:eye" size="14" />
            {{ $t('help.admin.editor.previewHeader') }}
          </span>
          <button type="button" class="flex h-[26px] w-[26px] items-center justify-center rounded text-muted-foreground hover:bg-secondary" @click="previewOpen = false">
            <Icon name="lucide:x" size="15" />
          </button>
        </div>
        <div class="min-h-0 flex-1 overflow-auto px-8 pt-7">
          <div class="mx-auto max-w-[720px]">
            <h1 class="mb-2.5 text-[30px] font-bold leading-[38px]! tracking-[-.02em]">{{ form.title }}</h1>
            <p v-if="form.description" class="mb-5 text-base leading-[26px] text-muted-foreground">{{ form.description }}</p>
            <hr class="mb-6 border-border">
            <ClientOnly>
              <div class="help-article-styled">
                <ThemedMdPreview :model-value="form.content" />
              </div>
            </ClientOnly>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div v-else class="flex h-full flex-col items-center justify-center gap-3 p-6" role="status">
    <Icon v-if="loadStatus === 'pending'" name="lucide:loader-2" class="animate-spin" />
    <template v-else-if="loadError">
      <p>{{ $t('help.admin.editor.loadFailed') }}</p>
      <Button variant="outline" @click="refresh()">{{ $t('help.admin.editor.retryLoad') }}</Button>
    </template>
  </div>
</template>

<style scoped>
/* Size against the actual dashboard space, including wrapped headers and zoom.
   Keep the writing surface bounded even on ultrawide/tall displays. */
.help-editor-body {
  display: flex;
  flex-direction: column;
  height: clamp(280px, 55dvh, 520px);
}

.help-editor-input {
  flex: 1 1 0;
  min-height: 0;
  height: 100%;
}

@media (min-width: 1024px) {
  .help-editor-form {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .help-editor-form > * {
    flex-shrink: 0;
  }

  .help-editor-body {
    flex: 1 0 280px;
    height: auto;
    min-height: 280px;
    max-height: 1200px;
  }
}
</style>
