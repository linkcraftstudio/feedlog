<script setup lang="ts">
interface SearchHit {
  shortId: string
  slug: string
  title: string
  titleRanges: [number, number][]
  excerpt: string
  excerptRanges: [number, number][]
  collection: { id: string; name: string }
}

const props = withDefaults(defineProps<{ query: string; autoTranslate?: boolean }>(), {
  autoTranslate: true,
})

const localePath = useLocalePath()

const hits = ref<SearchHit[]>([])
const total = ref(0)
const rateLimited = ref(false)
const failed = ref(false)
const fallback = ref(false)
const loading = ref(false)
const canTranslate = ref(false)
const translating = ref(false)
const translatedQueries = ref<string[]>([])

let timer: ReturnType<typeof setTimeout>
let seq = 0
let controller: AbortController | undefined

interface SearchResponse {
  total: number
  data: SearchHit[]
  searchMode?: string
  canTranslate?: boolean
  translatedQueries?: string[]
}

async function search(q: string, mine: number, translate = false) {
  controller = new AbortController()
  loading.value = true
  translating.value = translate
  canTranslate.value = false
  fallback.value = false
  try {
    const result = await $fetch<SearchResponse>('/api/help/search', {
      query: { q, ...(translate ? { translate: '1' } : {}) }, signal: controller.signal, retry: 0,
    })
    if (mine !== seq) return
    hits.value = result.data
    total.value = result.total
    fallback.value = result.searchMode === 'fallback'
    canTranslate.value = result.canTranslate === true || (translate && fallback.value)
    translatedQueries.value = result.translatedQueries ?? []
    rateLimited.value = false
    failed.value = false
    // Only the original, empty Chinese query can start one automatic retry.
    // Await it so the lexical request cannot clear the translation loading state.
    if (!translate && props.autoTranslate && !result.total && result.canTranslate && /[\u3400-\u9fff]/.test(q)) {
      await search(q, mine, true)
    }
  }
  catch (e) {
    if (mine !== seq) return
    failed.value = true
    hits.value = []
    total.value = 0
    rateLimited.value = (e as { statusCode?: number; response?: { status?: number } }).statusCode === 429
      || (e as { response?: { status?: number } }).response?.status === 429
    canTranslate.value = translate && !rateLimited.value
  }
  finally {
    if (mine === seq) {
      loading.value = false
      translating.value = false
    }
  }
}

function translateSearch() {
  if (loading.value || !canTranslate.value) return
  void search(props.query.trim(), seq, true)
}

watch(() => props.query, (value) => {
  clearTimeout(timer)
  const mine = ++seq
  controller?.abort()
  hits.value = []
  total.value = 0
  rateLimited.value = false
  failed.value = false
  fallback.value = false
  canTranslate.value = false
  translating.value = false
  translatedQueries.value = []
  const q = value.trim()
  loading.value = !!q
  if (!q) return
  timer = setTimeout(() => { void search(q, mine) }, 200)
}, { immediate: true })

onBeforeUnmount(() => {
  ++seq
  clearTimeout(timer)
  controller?.abort()
})

function segments(text: string, ranges: [number, number][]) {
  const out: { text: string; hit: boolean }[] = []
  let cursor = 0
  for (const [from, to] of ranges) {
    if (from > cursor) out.push({ text: text.slice(cursor, from), hit: false })
    out.push({ text: text.slice(from, to), hit: true })
    cursor = to
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false })
  return out
}
</script>

<template>
  <div class="absolute inset-x-0 top-[60px] z-20 overflow-hidden rounded-2xl border border-border bg-card shadow-[0_4px_20px_rgba(196,90,70,.08)]">
    <p v-if="translatedQueries.length" class="px-[18px] py-2 text-xs text-muted-foreground">
      {{ $t('help.portal.translatedSearch', { query: translatedQueries.join(' / ') }) }}
    </p>
    <template v-if="hits.length">
      <p class="border-b border-border px-[18px] py-2.5 text-[11px] font-bold uppercase tracking-[.05em] text-muted-foreground">
        {{ $t('help.portal.results', { n: total }, total) }}
      </p>
      <NuxtLink
        v-for="hit in hits"
        :key="hit.shortId"
        :to="localePath(`/help/${hit.shortId}-${hit.slug}`)"
        class="group block cursor-pointer border-b border-border px-[18px] py-3 hover:bg-background"
      >
        <div class="text-sm font-bold leading-5 group-hover:text-primary">
          <span v-for="(part, i) in segments(hit.title, hit.titleRanges)" :key="i" :class="part.hit && 'rounded-sm bg-primary/10 px-0.5 font-bold text-primary'">{{ part.text }}</span>
        </div>
        <div class="mt-1 line-clamp-2 text-xs leading-[18px] text-muted-foreground">
          <span v-for="(part, i) in segments(hit.excerpt, hit.excerptRanges)" :key="i" :class="part.hit && 'rounded-sm bg-primary/10 px-0.5 font-bold text-primary'">{{ part.text }}</span>
        </div>
        <div class="mt-[7px] flex items-center gap-[5px] text-[11px] font-bold leading-[15px] text-primary">
          <Icon name="lucide:book-open" size="12" />
          {{ hit.collection.name }}
        </div>
      </NuxtLink>
      <p v-if="total > hits.length" class="px-[18px] pb-3 pt-2.5 text-center text-[11px] leading-4 text-muted-foreground">
        {{ $t('help.portal.more', { n: total - hits.length }) }}
      </p>
    </template>

    <div v-else-if="loading" class="flex items-center justify-center gap-2 px-[18px] py-7" role="status">
      <Icon name="lucide:loader-2" size="20" class="animate-spin text-muted-foreground" />
      <span v-if="translating" class="text-sm text-muted-foreground">{{ $t('help.portal.translatingSearch') }}</span>
    </div>

    <div v-else class="px-[18px] py-7 text-center">
      <div class="text-sm font-semibold">{{ fallback ? $t('help.portal.crossLanguageUnavailable') : rateLimited ? $t('help.portal.rateLimited') : failed ? $t('help.portal.searchFailed') : $t('help.portal.noMatch') }}</div>
      <div class="mt-1 text-xs leading-[18px] text-muted-foreground">
        {{ fallback ? $t('help.portal.translationRetryHint') : rateLimited ? $t('help.portal.rateLimitedHint') : failed ? $t('help.portal.searchFailedHint') : canTranslate ? $t('help.portal.translationOfferHint') : $t('help.portal.noMatchHint') }}
      </div>
      <Button v-if="canTranslate" variant="outline" size="sm" class="mt-3" :disabled="loading" @click="translateSearch">
        {{ $t('help.portal.translateSearch') }}
      </Button>
    </div>
  </div>
</template>
