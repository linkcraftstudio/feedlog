<script setup lang="ts">
import draggable from 'vuedraggable'
import HelpIndexFailure from '#layers/feedlog/app/components/help/HelpIndexFailure.vue'
import type { HelpIndexStatus } from '#layers/feedlog/shared/types/help-index'
import { toast } from 'vue-sonner'
import type { HelpCollectionFormValue } from '#layers/feedlog/app/components/help/HelpCollectionDialog.vue'
import type { HelpArticleStatus, HelpCollectionIcon } from '#layers/feedlog/shared/constants/help'

definePageMeta({ layout: 'dashboard', middleware: 'admin' })

interface InlineArticle {
  id: string
  title: string
  indexStatus: HelpIndexStatus | null
  aiEnabled: boolean
  status: HelpArticleStatus
  position: number
  updatedAt: string
}

interface AdminCollection {
  id: string
  name: string
  description: string | null
  icon: HelpCollectionIcon
  visible: boolean
  position: number
  articleCount: number
  articles: InlineArticle[]
}

interface FlatArticle {
  id: string
  shortId: string
  slug: string
  title: string
  indexStatus: HelpIndexStatus | null
  aiEnabled: boolean
  status: HelpArticleStatus
  position: number
  updatedAt: string
  collection: { id: string; name: string; visible: boolean }
}

const PAGE_SIZE = 10

const { t } = useI18n()
const { confirm } = useConfirmDialog()
const localePath = useLocalePath()
const router = useRouter()

const view = ref<'collections' | 'articles'>('collections')
const search = ref('')
const debouncedSearch = ref('')
const page = ref(1)
const expanded = ref(new Set<string>())
const selected = ref(new Set<string>())
const dialogOpen = ref(false)
const editing = ref<HelpCollectionFormValue | null>(null)

let searchTimer: ReturnType<typeof setTimeout>
watch(search, (value) => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    debouncedSearch.value = value.trim()
    page.value = 1
    selected.value = new Set()
  }, 300)
})

watch(view, () => {
  page.value = 1
  selected.value = new Set()
})

watch(page, () => {
  selected.value = new Set()
})

const flat = computed(() => view.value === 'articles' || !!debouncedSearch.value)
const selecting = computed(() => selected.value.size > 0)

const { data: stats, refresh: refreshStats } = await useFetch<{ collectionCount: number; articleCount: number }>('/api/admin/help/stats')

const { data: collectionsData, refresh: refreshCollections } = await useFetch<{
  data: AdminCollection[]
}>('/api/admin/help/collections', {
  immediate: true,
  deep: true,
})

const { data: articlesData, refresh: refreshArticles } = await useFetch<{
  data: FlatArticle[]
  pagination: { total: number }
}>('/api/admin/help/articles', {
  deep: true,
  query: computed(() => ({ page: page.value, pageSize: PAGE_SIZE, q: debouncedSearch.value || undefined })),
})

const collections = computed(() => collectionsData.value?.data ?? [])
const articles = computed(() => articlesData.value?.data ?? [])

let indexPoll: ReturnType<typeof setInterval> | undefined
let pollingIndex = false
onMounted(() => {
  indexPoll = setInterval(async () => {
    if (pollingIndex || document.hidden) return
    const visibleArticles = flat.value ? articles.value : collections.value.flatMap(c => c.articles)
    const pending = visibleArticles.filter(a => a.indexStatus === 'indexing')
    if (!pending.length) return
    pollingIndex = true
    try {
      await Promise.allSettled(pending.map(async (article) => {
        const state = await $fetch<{ status: HelpIndexStatus; enabled: boolean }>(`/api/admin/help/articles/${article.id}/index-status`)
        for (const current of [...articles.value, ...collections.value.flatMap(c => c.articles)]) {
          if (current.id === article.id) current.indexStatus = state.enabled ? state.status : null
        }
      }))
    }
    finally { pollingIndex = false }
  }, 5000)
})
onBeforeUnmount(() => { clearInterval(indexPoll); clearTimeout(searchTimer) })

const total = computed(() => (flat.value ? articlesData.value?.pagination.total ?? 0 : collections.value.length))
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))

const isEmpty = computed(() => (stats.value?.collectionCount ?? 0) === 0 && (stats.value?.articleCount ?? 0) === 0)
const hasCollections = computed(() => (stats.value?.collectionCount ?? 0) > 0)

const draggableCollections = computed({
  get: () => collections.value,
  set: (value) => { if (collectionsData.value) collectionsData.value.data = value },
})

async function refreshAll() {
  await Promise.all([refreshStats(), refreshCollections(), refreshArticles()])
}

function toggleExpanded(id: string) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

function toggleSelected(id: string) {
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = next
}

function collectionSelection(collection: AdminCollection): 'none' | 'some' | 'all' {
  const ids = collection.articles.map(a => a.id)
  if (!ids.length) return 'none'
  const hit = ids.filter(id => selected.value.has(id)).length
  return hit === 0 ? 'none' : hit === ids.length ? 'all' : 'some'
}

function toggleCollectionSelection(collection: AdminCollection) {
  const next = new Set(selected.value)
  const state = collectionSelection(collection)
  for (const article of collection.articles) {
    if (state === 'all') next.delete(article.id)
    else next.add(article.id)
  }
  selected.value = next
  if (state !== 'all' && !expanded.value.has(collection.id)) toggleExpanded(collection.id)
}

function openCreate() {
  editing.value = null
  dialogOpen.value = true
}

function openEdit(collection: AdminCollection) {
  editing.value = {
    id: collection.id,
    name: collection.name,
    description: collection.description,
    icon: collection.icon,
    visible: collection.visible,
    articleCount: collection.articleCount,
  }
  dialogOpen.value = true
}

function createArticle() {
  const collectionId = collections.value[0]?.id
  if (!collectionId) return
  return router.push({ path: localePath('/dashboard/help/new'), query: { collection: collectionId } })
}

function onCollectionDragStart(event: { oldIndex?: number }) {
  const dragged = collections.value[event.oldIndex ?? -1]
  if (!dragged || !expanded.value.has(dragged.id)) return
  const next = new Set(expanded.value)
  next.delete(dragged.id)
  expanded.value = next
}

async function onCollectionsDragEnd() {
  try {
    await $fetch('/api/admin/help/collections/reorder', {
      method: 'PATCH',
      body: { ids: collections.value.map(c => c.id) },
    })
  }
  catch {
    toast.error(t('help.admin.reorderFailed'))
    await refreshAll()
  }
}

async function onArticlesDragEnd(collection: AdminCollection) {
  try {
    await $fetch('/api/admin/help/articles/reorder', {
      method: 'PATCH',
      body: { collectionId: collection.id, ids: collection.articles.map(a => a.id) },
    })
  }
  catch {
    toast.error(t('help.admin.reorderFailed'))
    await refreshAll()
  }
}

async function runBulk(action: 'publish' | 'unpublish' | 'ai-visibility', aiEnabled?: boolean) {
  const ids = [...selected.value]
  if (!ids.length) return
  if (action === 'publish') {
    const ok = await confirm({
      title: t('help.admin.bulkPublishTitle', { n: ids.length }, ids.length),
      confirmText: t('help.admin.publish'),
      cancelText: t('common.cancel'),
    })
    if (!ok) return
  }
  try {
    const result = await $fetch<{ affected: number }>(`/api/admin/help/articles/bulk-${action}`, {
      method: 'POST',
      body: { ids, ...(aiEnabled === undefined ? {} : { aiEnabled }) },
    })
    selected.value = new Set()
    await refreshAll()
    toast.success(action === 'ai-visibility' ? t('help.admin.aiUpdated') : t(`help.admin.${action}Result`, { n: result.affected }, result.affected))
  }
  catch {
    toast.error(t('help.admin.bulkFailed'))
  }
}

const CHIP = 'inline-flex shrink-0 items-center rounded border px-2 py-0.5 text-[10px] font-bold leading-[15px]'

const rangeFrom = computed(() => (total.value === 0 ? 0 : (page.value - 1) * PAGE_SIZE + 1))
const rangeTo = computed(() => Math.min(page.value * PAGE_SIZE, total.value))

function formatDate(iso: string) {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(iso))
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <header class="flex h-16 shrink-0 items-center justify-between border-b border-border bg-card px-6">
      <div class="flex items-center gap-4">
        <h2 class="font-heading text-lg font-bold">{{ $t('help.admin.title') }}</h2>
        <div class="h-4 w-px bg-border" />
        <span class="text-xs font-medium text-muted-foreground">
          <template v-if="isEmpty">{{ $t('help.admin.statsEmpty') }}</template>
          <template v-else>
            {{ $t('help.admin.statsCollections', { n: stats?.collectionCount ?? 0 }, stats?.collectionCount ?? 0) }}
            ·
            {{ $t('help.admin.statsArticles', { n: stats?.articleCount ?? 0 }, stats?.articleCount ?? 0) }}
          </template>
        </span>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <button
            type="button"
            class="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-bold text-primary-foreground hover:bg-primary/90"
          >
            <Icon name="lucide:plus" size="16" />
            {{ $t('help.admin.new') }}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-64">
          <DropdownMenuItem class="group flex-col !items-start gap-0.5 py-2" @select="openCreate">
            <span class="text-sm font-bold">{{ $t('help.admin.newCollection') }}</span>
            <span class="text-xs text-muted-foreground group-focus:text-accent-foreground/80">{{ $t('help.admin.newCollectionHint') }}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            class="group flex-col !items-start gap-0.5 py-2"
            :disabled="!hasCollections"
            @select="createArticle"
          >
            <span class="text-sm font-bold">{{ $t('help.admin.newArticle') }}</span>
            <span class="text-xs text-muted-foreground group-focus:text-accent-foreground/80">
              {{ hasCollections ? $t('help.admin.newArticleHint') : $t('help.admin.newArticleDisabledHint') }}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>

    <div v-if="!isEmpty" class="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-background/30 px-6 py-4">
      <template v-if="selected.size">
        <div class="flex h-9 items-center gap-3">
          <span class="text-[13px] font-bold leading-[18px]">{{ $t('help.admin.selected', { n: selected.size }, selected.size) }}</span>
          <button type="button" class="text-xs font-bold text-muted-foreground hover:text-foreground" @click="selected = new Set()">
            {{ $t('help.admin.clear') }}
          </button>
        </div>
        <div class="flex h-9 items-center gap-2">
          <button
            type="button"
            class="inline-flex h-8 items-center rounded-lg border border-border px-3 text-xs font-bold hover:bg-secondary"
            @click="runBulk('unpublish')"
          >
            {{ $t('help.admin.unpublish') }}
          </button>
          <button
            type="button"
            class="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-xs font-bold text-primary-foreground hover:bg-primary/90"
            @click="runBulk('publish')"
          >
            {{ $t('help.admin.publish') }}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <button type="button" class="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-bold hover:bg-secondary">
                {{ $t('help.admin.aiVisibility') }}<Icon name="lucide:chevron-down" size="13" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem @select="runBulk('ai-visibility', true)">{{ $t('help.admin.aiEnable') }}</DropdownMenuItem>
              <DropdownMenuItem @select="runBulk('ai-visibility', false)">{{ $t('help.admin.aiDisable') }}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </template>

      <template v-else>
        <div class="flex items-center gap-1 rounded-2xl bg-secondary p-[3px]">
          <button
            v-for="option in (['collections', 'articles'] as const)"
            :key="option"
            type="button"
            class="h-[26px] whitespace-nowrap rounded-lg px-3 text-xs font-bold leading-4 transition-colors"
            :class="view === option ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
            @click="view = option"
          >
            {{ option === 'collections' ? $t('help.admin.viewCollections') : $t('help.admin.viewArticles') }}
          </button>
        </div>
        <div class="relative flex w-64 items-center text-muted-foreground">
          <Icon name="lucide:search" size="14" class="absolute left-3" />
          <input
            v-model="search"
            type="text"
            class="h-9 w-full rounded-lg border border-border bg-card pl-9 pr-8 text-[13px] text-foreground outline-none focus:border-primary"
            :placeholder="$t('help.admin.searchPlaceholder')"
          >
          <button v-if="search" type="button" class="absolute right-2.5 flex hover:text-foreground" @click="search = ''">
            <Icon name="lucide:x" size="13" />
          </button>
        </div>
      </template>
    </div>

    <div v-if="isEmpty" class="grid flex-1 place-items-center bg-card p-10">
      <div class="max-w-[460px] text-center">
        <div class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-secondary text-primary">
          <Icon name="lucide:book-open" size="26" />
        </div>
        <p class="text-lg font-bold leading-[26px]">{{ $t('help.admin.emptyHeading') }}</p>
        <p class="mt-2 text-sm leading-[22px] text-muted-foreground">{{ $t('help.admin.emptyTitle') }}</p>
        <button
          type="button"
          class="mt-[22px] inline-flex h-9 items-center rounded-lg bg-primary px-4 text-xs font-bold text-primary-foreground hover:bg-primary/90"
          @click="openCreate"
        >
          {{ $t('help.admin.emptyAction') }}
        </button>
      </div>
    </div>

    <template v-else>
      <div class="min-h-0 flex-1 overflow-auto bg-card">
        <template v-if="flat">
          <p v-if="!articles.length" class="px-6 py-14 text-center text-[13px] text-muted-foreground">
            {{ $t('help.admin.noMatch') }}
          </p>
          <NuxtLink
            v-for="article in articles"
            :key="article.id"
            :to="localePath(`/dashboard/help/${article.id}`)"
            class="group flex cursor-pointer items-center gap-3.5 border-b border-border bg-background py-3 pl-16 pr-6 hover:bg-secondary"
            :class="selected.has(article.id) && '!bg-primary/5'"
          >
            <button
              type="button"
              class="flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] border-2 bg-card transition-all"
              :class="selected.has(article.id)
                ? 'border-primary bg-primary text-primary-foreground opacity-100'
                : `border-border text-transparent ${selecting ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`"
              @click.prevent.stop="toggleSelected(article.id)"
            >
              <Icon name="lucide:check" size="13" />
            </button>
            <span class="invisible flex shrink-0"><Icon name="lucide:grip-vertical" size="14" /></span>
            <span class="min-w-0 flex-1 truncate text-sm font-semibold leading-5">{{ article.title }}</span>
            <span :class="[CHIP, 'gap-1 border-transparent bg-secondary text-primary']">
              <Icon v-if="!article.collection.visible" name="lucide:eye-off" size="11" />
              {{ article.collection.name }}
            </span>
            <HelpStatusBadge :status="article.status" />
            <span v-if="article.aiEnabled" :class="[CHIP, 'gap-1 border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300']"><Icon name="lucide:sparkles" size="11" />{{ $t('help.admin.aiVisible') }}</span>
            <HelpIndexFailure v-if="article.indexStatus === 'failed' || article.indexStatus === 'indexing'" :indexing="article.indexStatus === 'indexing'" />
            <span class="w-24 shrink-0 text-right text-xs font-medium leading-4 text-muted-foreground">{{ formatDate(article.updatedAt) }}</span>
          </NuxtLink>
        </template>

        <ClientOnly v-else>
          <draggable
            v-model="draggableCollections"
            item-key="id"
            handle=".drag-handle"
            ghost-class="opacity-50"
            @start="onCollectionDragStart"
            @end="onCollectionsDragEnd"
          >
            <template #item="{ element: collection }">
              <div>
                <div
                  class="group relative flex cursor-pointer items-center gap-3.5 border-b border-border px-6 py-3.5 hover:bg-background/60"
                  @click="toggleExpanded(collection.id)"
                >
                  <div
                    class="drag-handle absolute left-[5px] top-1/2 flex -translate-y-1/2 cursor-grab text-muted-foreground opacity-0 transition-opacity group-hover:opacity-55"
                    @click.stop
                  >
                    <Icon name="lucide:grip-vertical" size="14" />
                  </div>
                  <button
                    type="button"
                    class="flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] border-2 bg-card transition-all"
                    :class="collectionSelection(collection) !== 'none'
                      ? 'border-primary bg-primary text-primary-foreground opacity-100'
                      : `border-border text-transparent ${selecting ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`"
                    @click.stop="toggleCollectionSelection(collection)"
                  >
                    <Icon v-if="collectionSelection(collection) === 'all'" name="lucide:check" size="13" />
                    <span v-else-if="collectionSelection(collection) === 'some'" class="h-0.5 w-2.5 rounded-full bg-primary-foreground" />
                  </button>
                  <Icon
                    name="lucide:chevron-right"
                    size="16"
                    class="shrink-0 text-muted-foreground transition-transform"
                    :class="expanded.has(collection.id) && 'rotate-90'"
                  />
                  <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-secondary text-primary">
                    <Icon :name="`lucide:${collection.icon}`" size="16" />
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-sm font-bold leading-5">{{ collection.name }}</span>
                    <span class="block truncate text-xs leading-4 text-muted-foreground">{{ collection.description }}</span>
                  </span>
                  <span class="shrink-0 text-xs font-medium leading-4 text-muted-foreground">
                    {{ $t('help.admin.articleCount', { n: collection.articleCount }, collection.articleCount) }}
                  </span>
                  <button
                    type="button"
                    class="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
                    @click.stop="openEdit(collection)"
                  >
                    <Icon name="lucide:ellipsis" size="16" />
                  </button>
                </div>

                <draggable
                  v-if="expanded.has(collection.id)"
                  v-model="collection.articles"
                  item-key="id"
                  handle=".drag-handle"
                  ghost-class="opacity-50"
                  @end="onArticlesDragEnd(collection)"
                >
                  <template #item="{ element: article }">
                    <NuxtLink
                      :to="localePath(`/dashboard/help/${article.id}`)"
                      class="group flex cursor-pointer items-center gap-3.5 border-b border-border bg-background py-3 pl-16 pr-6 hover:bg-secondary"
                      :class="selected.has(article.id) && '!bg-primary/5'"
                    >
                      <button
                        type="button"
                        class="flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] border-2 bg-card transition-all"
                        :class="selected.has(article.id)
                          ? 'border-primary bg-primary text-primary-foreground opacity-100'
                          : `border-border text-transparent ${selecting ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`"
                        @click.prevent.stop="toggleSelected(article.id)"
                      >
                        <Icon name="lucide:check" size="13" />
                      </button>
                      <div class="drag-handle flex shrink-0 cursor-grab text-muted-foreground opacity-40" @click.prevent.stop>
                        <Icon name="lucide:grip-vertical" size="14" />
                      </div>
                      <span class="min-w-0 flex-1 truncate text-sm font-semibold leading-5">{{ article.title }}</span>
                      <HelpStatusBadge :status="article.status" />
                      <span v-if="article.aiEnabled" :class="[CHIP, 'gap-1 border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300']"><Icon name="lucide:sparkles" size="11" />{{ $t('help.admin.aiVisible') }}</span>
                      <HelpIndexFailure v-if="article.indexStatus === 'failed' || article.indexStatus === 'indexing'" :indexing="article.indexStatus === 'indexing'" />
                      <span class="w-24 shrink-0 text-right text-xs font-medium leading-4 text-muted-foreground">{{ formatDate(article.updatedAt) }}</span>
                    </NuxtLink>
                  </template>
                </draggable>
              </div>
            </template>
          </draggable>
        </ClientOnly>
      </div>

      <div v-if="flat" class="flex h-16 shrink-0 items-center justify-between border-t border-border bg-card px-6">
        <span class="text-xs font-medium text-muted-foreground">
          {{ $t('help.admin.showing', { from: rangeFrom, to: rangeTo, total }) }}
        </span>
        <div class="flex gap-2">
          <button
            type="button"
            class="flex h-8 w-8 items-center justify-center rounded border border-border text-xs font-bold disabled:opacity-40"
            :disabled="page <= 1"
            @click="page--"
          >
            <Icon name="lucide:chevron-left" size="16" />
          </button>
          <button
            v-for="n in pageCount"
            :key="n"
            type="button"
            class="h-8 w-8 rounded border border-border text-xs font-bold transition-colors"
            :class="n === page ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-secondary'"
            @click="page = n"
          >
            {{ n }}
          </button>
          <button
            type="button"
            class="flex h-8 w-8 items-center justify-center rounded border border-border text-xs font-bold disabled:opacity-40"
            :disabled="page >= pageCount"
            @click="page++"
          >
            <Icon name="lucide:chevron-right" size="16" />
          </button>
        </div>
      </div>
    </template>

    <HelpCollectionDialog v-model:open="dialogOpen" :collection="editing" @saved="refreshAll" @deleted="refreshAll" />
  </div>
</template>
