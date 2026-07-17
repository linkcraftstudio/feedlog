<script setup lang="ts">
import { useMediaQuery } from '@vueuse/core'
const q = defineModel<string>({ default: '' })
const sortBy = defineModel<'top' | 'recent'>('sort', { default: 'recent' })
const emit = defineEmits<{ 'new-request': [] }>()

const searchOpen = ref(false)
const searchInput = ref<HTMLInputElement | null>(null)
const rawQuery = ref('')

const isMobile = useMediaQuery('(max-width: 639.98px)')
const searchOpenDesktop = computed(() => searchOpen.value && !isMobile.value)
const searchOpenMobile = computed(() => searchOpen.value && isMobile.value)
const searchActive = computed(() => rawQuery.value.trim().length > 0)
let searchTimer: ReturnType<typeof setTimeout> | null = null

const searchTrigger = ref<HTMLElement | null>(null)
const controlsRow = ref<HTMLElement | null>(null)
const clipLeft = ref('50%')
const clipRight = ref('50%')
const mobileClip = computed(() => ({ '--fl-clip-left': clipLeft.value, '--fl-clip-right': clipRight.value }))

// Debounce the input and EMIT it (page owns the fetch). Emptying emits '' so the
// page's single q-watch restores the board list — no double-fetch, no programmaticClear.
watch(rawQuery, () => {
  if (searchTimer) clearTimeout(searchTimer)
  if (!rawQuery.value.trim()) { q.value = ''; return }
  searchTimer = setTimeout(() => { q.value = rawQuery.value.trim() }, 250)
})

function openSearch() {
  if (isMobile.value && searchTrigger.value && controlsRow.value) {
    const t = searchTrigger.value.getBoundingClientRect()
    const b = controlsRow.value.getBoundingClientRect()
    clipLeft.value = `${Math.max(0, Math.round(t.left - b.left))}px`
    clipRight.value = `${Math.max(0, Math.round(b.right - t.right))}px`
  }
  searchOpen.value = true
}

function onSearchRevealed() {
  if (searchOpen.value) searchInput.value?.focus()
}

function clearSearch() {
  if (searchTimer) clearTimeout(searchTimer)
  rawQuery.value = ''
  searchInput.value?.focus()
}

function closeSearch() {
  if (searchTimer) clearTimeout(searchTimer)
  rawQuery.value = ''
  searchOpen.value = false
}

function clearOrClose() {
  if (searchActive.value) clearSearch()
  else closeSearch()
}

function reset() {
  if (searchTimer) clearTimeout(searchTimer)
  rawQuery.value = ''
  searchOpen.value = false
}
defineExpose({ reset })
</script>

<template>
  <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2">
    <Transition name="fl-left" mode="out-in" @after-enter="onSearchRevealed">
      <h2 v-if="!searchOpenDesktop" class="font-heading text-2xl font-bold">
        {{ sortBy === 'top' ? $t('board.topRequests') : $t('board.recentRequests') }}
      </h2>
      <div v-else class="fl-search">
        <Icon name="lucide:search" size="18" class="fl-search__icon" />
        <input
          ref="searchInput"
          v-model="rawQuery"
          type="text"
          :placeholder="$t('board.searchPlaceholder')"
          autocomplete="off"
          class="fl-search__input"
          @keydown.esc="closeSearch"
        >
        <button
          type="button"
          class="fl-search__clear"
          :aria-label="searchActive ? $t('board.clearSearch') : $t('board.closeSearch')"
          @click="clearOrClose"
        >
          <Icon name="lucide:x" size="16" />
        </button>
      </div>
    </Transition>

    <div ref="controlsRow" class="fl-rightbar flex items-center relative">
      <Transition name="fl-controls">
        <div v-if="!searchOpen" class="flex items-center gap-3">
          <div class="flex bg-border/50 p-1 rounded-lg">
            <button
              class="px-4 py-1.5 rounded-[12px] text-sm font-medium transition-colors"
              :class="sortBy === 'top'
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'"
              @click="sortBy = 'top'"
            >
              {{ $t('board.sortTop') }}
            </button>
            <button
              class="px-4 py-1.5 rounded-[12px] text-sm font-medium transition-colors"
              :class="sortBy === 'recent'
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'"
              @click="sortBy = 'recent'"
            >
              {{ $t('board.sortRecent') }}
            </button>
          </div>
          <button
            ref="searchTrigger"
            type="button"
            class="fl-toolbtn fl-toolbtn--search"
            :aria-label="$t('board.search')"
            @click="openSearch"
          >
            <Icon name="lucide:search" size="18" />
            <span class="hidden sm:inline">{{ $t('board.search') }}</span>
          </button>
        </div>
      </Transition>
      <Transition name="fl-newreq">
        <Button
          v-show="!searchOpenMobile"
          class="h-10 px-4 rounded-lg text-[15px] font-heading font-semibold"
          @click="emit('new-request')"
        >
          <Icon name="lucide:plus" size="18" />
          {{ $t('board.newRequest') }}
        </Button>
      </Transition>

      <Transition name="fl-msearch" @after-enter="onSearchRevealed">
        <div v-if="searchOpenMobile" class="fl-search fl-search--mobile" :style="mobileClip">
          <Icon name="lucide:search" size="18" class="fl-search__icon" />
          <input
            ref="searchInput"
            v-model="rawQuery"
            type="text"
            :placeholder="$t('board.searchPlaceholder')"
            autocomplete="off"
            class="fl-search__input"
            @keydown.esc="closeSearch"
          >
          <button
            type="button"
            class="fl-search__clear"
            :aria-label="searchActive ? $t('board.clearSearch') : $t('board.closeSearch')"
            @click="clearOrClose"
          >
            <Icon name="lucide:x" size="16" />
          </button>
        </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.fl-toolbtn {
  height: 40px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--card);
  color: var(--muted-foreground);
  font-size: 14px;
  font-weight: 500;
  transition: border-color 0.15s ease, color 0.15s ease;
}
.fl-toolbtn:hover {
  border-color: var(--primary);
  color: var(--foreground);
}

.fl-search {
  position: relative;
  /* Grow to fill the toolbar row up to New Request — no max-width, otherwise the
     parent's justify-between dumps the slack as a gap between field and button. */
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
  /* Pin the field's RIGHT edge (next to New Request, where the Search button was)
     so the open/close accordion below grows the LEFT edge outward — i.e. it expands
     right→left and collapses left→right. While max-width caps the field narrow,
     this auto margin eats the slack on the left and parks it at the right; at full
     width the slack is zero, so it resolves to 0 and nothing shifts. */
  margin-left: auto;
}
.fl-search__icon {
  position: absolute;
  left: 14px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--muted-foreground);
  pointer-events: none;
  transition: color 0.15s ease;
}
.fl-search:focus-within .fl-search__icon {
  color: var(--primary);
}
.fl-search__input {
  height: 40px;
  width: 100%;
  padding: 0 38px 0 42px;
  font-size: 15px;
  color: var(--foreground);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.fl-search__input::placeholder {
  color: var(--muted-foreground);
}
.fl-search__input:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--primary) 15%, transparent);
}
.fl-search__clear {
  position: absolute;
  right: 7px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  color: var(--muted-foreground);
  transition: background-color 0.15s ease, color 0.15s ease;
}
.fl-search__clear:hover {
  background: var(--secondary);
  color: var(--foreground);
}

.fl-left-enter-active.fl-search,
.fl-left-leave-active.fl-search {
  transition: max-width 0.22s cubic-bezier(0.22, 0.61, 0.36, 1);
  overflow: hidden;
}
.fl-left-enter-from.fl-search,
.fl-left-leave-to.fl-search {
  max-width: 0;
}
.fl-left-enter-to.fl-search,
.fl-left-leave-from.fl-search {
  max-width: 720px;
}

.fl-left-enter-active:not(.fl-search),
.fl-left-leave-active:not(.fl-search) {
  transition: opacity 0.12s ease;
}
.fl-left-enter-from:not(.fl-search),
.fl-left-leave-to:not(.fl-search) {
  opacity: 0;
}

.fl-controls-enter-active,
.fl-controls-leave-active {
  transition: max-width 0.22s cubic-bezier(0.22, 0.61, 0.36, 1);
  overflow: hidden;
  justify-content: flex-end;
}
.fl-controls-enter-active > *,
.fl-controls-leave-active > * {
  flex-shrink: 0;
}
.fl-controls-enter-from,
.fl-controls-leave-to {
  max-width: 0;
}
.fl-controls-enter-to,
.fl-controls-leave-from {
  max-width: 320px;
}

.fl-rightbar {
  gap: 0.75rem;
  position: relative; /* anchors the mobile search overlay; inert on desktop */
}

@media (max-width: 639.98px) {
  .fl-rightbar {
    gap: 0.5rem;
    min-height: 40px;
  }
  .fl-toolbtn--search {
    width: 40px;
    padding: 0;
    gap: 0;
    justify-content: center;
  }
  .fl-search--mobile {
    position: absolute;
    inset: 0 0 auto 0; /* top/left/right pinned; a 40px band along the row top */
    flex: none;
    width: 100%;
    z-index: 5;
  }
  .fl-controls-enter-active,
  .fl-controls-leave-active {
    transition: none;
  }
}

.fl-msearch-enter-active,
.fl-msearch-leave-active {
  transition: clip-path 0.24s cubic-bezier(0.22, 0.61, 0.36, 1), opacity 0.2s ease;
}
.fl-msearch-enter-to,
.fl-msearch-leave-from {
  clip-path: inset(0 0 0 0);
}
.fl-msearch-enter-from,
.fl-msearch-leave-to {
  clip-path: inset(0 var(--fl-clip-right, 50%) 0 var(--fl-clip-left, 50%));
}
.fl-msearch-leave-to {
  opacity: 0;
}

.fl-newreq-enter-active {
  transition: clip-path 0.13s cubic-bezier(0.22, 0.61, 0.36, 1),
              opacity 0.1s ease;
}
.fl-newreq-enter-to {
  clip-path: inset(0 0 0 0);
}
.fl-newreq-enter-from {
  clip-path: inset(0 0 0 100%);
  opacity: 0;
}

.fl-newreq-leave-active {
  transition: clip-path 0.18s cubic-bezier(0.22, 0.61, 0.36, 1),
              opacity 0.14s ease;
}
.fl-newreq-leave-from {
  clip-path: inset(0 0 0 0);
}
.fl-newreq-leave-to {
  clip-path: inset(0 100% 0 0);
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .fl-toolbtn,
  .fl-search__icon,
  .fl-search__input,
  .fl-search__clear,
  .fl-left-enter-active,
  .fl-left-leave-active,
  .fl-left-enter-active.fl-search,
  .fl-left-leave-active.fl-search,
  .fl-controls-enter-active,
  .fl-controls-leave-active,
  .fl-msearch-enter-active,
  .fl-msearch-leave-active,
  .fl-newreq-enter-active,
  .fl-newreq-leave-active {
    transition: none;
  }
}
</style>
