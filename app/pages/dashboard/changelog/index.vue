<script setup lang="ts">
import { resolveAttachmentUrl } from '~/utils/attachment'

definePageMeta({ layout: 'dashboard', middleware: 'admin' })

const { t } = useI18n()
const localePath = useLocalePath()

const listSearch = ref('')
const listStatus = ref<'all' | string>('all')

const statusOptions = computed(() => [
  { value: 'all', label: t('changelog.admin.status.all') },
  { value: 'published', label: t('changelog.admin.status.published') },
  { value: 'draft', label: t('changelog.admin.status.draft') },
  { value: 'needs_update', label: t('changelog.admin.status.needs_update') },
])

const categoryLabel = computed<Record<string, string>>(() => ({
  new: t('changelog.category.new'),
  improved: t('changelog.category.improved'),
  fixed: t('changelog.category.fixed'),
}))

const pageSize = 10
const currentPage = ref(1)

const debouncedSearch = ref('')
let searchTimer: ReturnType<typeof setTimeout>
watch(listSearch, (val) => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    debouncedSearch.value = val
    currentPage.value = 1
  }, 300)
})

watch(listStatus, () => { currentPage.value = 1 })

const { data: listData, status: fetchStatus } = await useFetch<PagePaginatedList<ChangelogAdminListItem>>('/api/admin/changelogs', {
  query: computed(() => ({
    status: listStatus.value !== 'all' ? listStatus.value : undefined,
    search: debouncedSearch.value || undefined,
    page: currentPage.value,
    pageSize,
  })),
})

const items = computed(() => listData.value?.data ?? [])
const total = computed(() => listData.value?.pagination?.total ?? 0)
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))

const pageNumbers = computed(() => {
  const current = currentPage.value
  const totalPages = pageCount.value
  const maxPages = 5

  if (totalPages <= maxPages) {
    return Array.from({ length: totalPages }, (_, i) => i + 1)
  }

  let start = Math.max(1, current - Math.floor(maxPages / 2))
  let end = start + maxPages - 1

  if (end > totalPages) {
    end = totalPages
    start = Math.max(1, end - maxPages + 1)
  }

  const pages: number[] = []
  for (let i = start; i <= end; i++) pages.push(i)
  return pages
})

function formatListDate(iso: string | null) {
  if (!iso) return '-'
  return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(iso))
}

function displayDate(item: ChangelogAdminListItem) {
  return formatListDate(item.publishedAt ?? item.updatedAt)
}

function statusLabel(status: string) {
  return t(`changelog.admin.status.${status}`)
}

function statusBadgeClass(status: string) {
  if (status === 'published') {
    return 'border-success/40 text-success bg-background'
  }
  if (status === 'needs_update') {
    return 'border-chart-2/50 text-chart-2 bg-background'
  }
  return 'border-orange-400/50 text-orange-600 dark:text-orange-400 bg-background'
}

function typeBadgeClass(type: string) {
  if (type === 'new') return 'text-primary bg-primary/10 border-primary/25'
  if (type === 'improved') return 'text-chart-2 bg-chart-2/10 border-chart-2/25'
  return 'text-success bg-success/10 border-success/25'
}

function handleCreate() {
  navigateTo(localePath('/dashboard/changelog/new'))
}

function handleSelect(id: string) {
  navigateTo(localePath(`/dashboard/changelog/${id}`))
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <!-- Top bar -->
    <header class="h-16 px-6 border-b border-border flex items-center justify-between shrink-0 bg-card backdrop-blur-sm">
      <div class="flex items-center gap-4">
        <h2 class="font-heading text-lg font-bold">{{ $t('changelog.admin.title') }}</h2>
        <div class="h-4 w-[1px] bg-border" />
        <span class="text-xs font-medium text-muted-foreground">{{ $t('changelog.admin.subtitle') }}</span>
      </div>
      <button
        type="button"
        class="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-primary px-4 text-xs font-bold text-primary-foreground hover:bg-primary/90"
        @click="handleCreate"
      >
        <Icon name="lucide:plus" size="16" />
        {{ $t('changelog.admin.create') }}
      </button>
    </header>

    <!-- Filter bar -->
    <div class="px-6 py-4 border-b border-border flex flex-wrap items-center justify-between gap-3 bg-background/30 shrink-0">
      <FilterTag
        v-model="listStatus"
        :label="$t('changelog.admin.filterStatus')"
        icon="lucide:filter"
        :options="statusOptions"
        :removable="false"
      />
      <div class="relative w-full sm:w-64">
        <Icon name="lucide:search" size="14" class="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input
          v-model="listSearch"
          type="text"
          :placeholder="$t('changelog.admin.searchPlaceholder')"
          class="h-7 w-full rounded-md border border-border bg-background pl-8 pr-3 text-xs outline-none focus:ring-2 focus:ring-primary/30"
        >
      </div>
    </div>

    <!-- List -->
    <section class="flex min-h-0 flex-1 flex-col bg-background">
      <div class="min-h-0 flex-1 divide-y divide-border overflow-auto" :class="{ 'opacity-50 pointer-events-none': fetchStatus === 'pending' && items.length > 0 }">
        <!-- Loading -->
        <div v-if="fetchStatus === 'pending' && items.length === 0" class="flex items-center justify-center py-16">
          <div class="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" />
        </div>

        <button
          v-for="item in items"
          :key="item.id"
          type="button"
          class="flex w-full gap-[16px] px-[24px] py-[20px] text-left transition-colors hover:bg-muted/40"
          @click="handleSelect(item.id)"
        >
          <div
            class="relative h-[88px] w-[136px] shrink-0 overflow-hidden rounded-[8px] border border-border bg-muted"
          >
            <img
              v-if="item.cover"
              :src="resolveAttachmentUrl(item.cover)!"
              alt=""
              class="size-full object-cover"
            >
            <div
              v-else
              class="flex size-full items-center justify-center px-[8px] text-center text-[11px] font-medium leading-[16px] text-muted-foreground"
            >
              {{ $t('changelog.admin.noImage') }}
            </div>
          </div>

          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-x-[12px] gap-y-[4px]">
              <p class="font-heading text-[18px] font-bold leading-[26px] text-foreground">
                {{ item.title }}
              </p>
              <div v-if="item.categories && item.categories.length" class="flex flex-wrap items-center gap-[6px]">
                <span
                  v-for="type in item.categories"
                  :key="type"
                  class="inline-flex h-[22px] items-center rounded-[6px] border px-[8px] text-[11px] font-bold capitalize leading-[16px]"
                  :class="typeBadgeClass(type)"
                >
                  {{ categoryLabel[type] ?? type }}
                </span>
              </div>
            </div>

            <div class="mt-[12px] flex flex-wrap items-center gap-x-[16px] gap-y-[8px]">
              <span
                class="inline-flex h-[24px] items-center gap-[4px] rounded-[6px] border px-[8px] text-[11px] font-semibold leading-[16px] capitalize"
                :class="statusBadgeClass(item.status)"
              >
                <Icon
                  v-if="item.status === 'published'"
                  name="lucide:check-circle"
                  size="12"
                  class="opacity-80"
                />
                <Icon
                  v-else-if="item.status === 'draft'"
                  name="lucide:pencil-line"
                  size="12"
                  class="opacity-80"
                />
                <Icon
                  v-else
                  name="lucide:alert-circle"
                  size="12"
                  class="opacity-80"
                />
                {{ statusLabel(item.status) }}
              </span>

              <span class="inline-flex items-center gap-[6px] text-[12px] font-medium leading-[18px] text-muted-foreground">
                <Icon name="lucide:clock" size="14" class="shrink-0 opacity-70" />
                {{ displayDate(item) }}
              </span>
            </div>
          </div>
        </button>

        <p
          v-if="fetchStatus !== 'pending' && items.length === 0"
          class="px-[24px] py-[32px] text-center text-[14px] leading-[22px] text-muted-foreground"
        >
          {{ $t('changelog.admin.noEntries') }}
        </p>
      </div>

      <!-- Pagination -->
      <div v-if="total > 0" class="h-14 md:h-16 px-4 md:px-6 border-t border-border flex items-center justify-between bg-card shrink-0">
        <span class="hidden md:block text-xs text-muted-foreground font-medium">
          {{ $t('changelog.admin.showing', { from: (currentPage - 1) * pageSize + 1, to: Math.min(currentPage * pageSize, total), total }) }}
        </span>
        <span class="md:hidden text-xs text-muted-foreground font-medium">
          {{ $t('changelog.admin.entriesShort', { total }) }}
        </span>
        <div class="flex items-center gap-2">
          <button
            class="w-8 h-8 flex items-center justify-center rounded border border-border hover:bg-background disabled:opacity-50"
            :disabled="currentPage <= 1"
            @click="currentPage--"
          >
            <Icon name="lucide:chevron-left" size="16" />
          </button>
          <button
            v-for="page in pageNumbers"
            :key="page"
            class="w-8 h-8 flex items-center justify-center rounded text-xs font-bold"
            :class="currentPage === page
              ? 'bg-primary text-primary-foreground'
              : 'border border-border hover:bg-background'"
            @click="currentPage = page"
          >
            {{ page }}
          </button>
          <button
            class="w-8 h-8 flex items-center justify-center rounded border border-border hover:bg-background disabled:opacity-50"
            :disabled="currentPage >= pageCount"
            @click="currentPage++"
          >
            <Icon name="lucide:chevron-right" size="16" />
          </button>
        </div>
      </div>
    </section>
  </div>
</template>
