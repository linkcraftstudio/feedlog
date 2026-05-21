<script setup lang="ts">

const props = defineProps<{
  changelogId: string
  reactionCounts: Record<string, number>
  userReactions: string[]
}>()

const emit = defineEmits<{
  update: [reactionCounts: Record<string, number>, userReactions: string[]]
}>()

const counts = reactive<Record<string, number>>({ ...props.reactionCounts })
const picked = reactive<Record<string, boolean>>({})
const pickerOpen = ref(false)
const rootRef = ref<HTMLElement | null>(null)

const { data: session } = useAuthSession()
const isLoggedIn = computed(() => !!session.value?.user)
const loginModal = useLoginModal()

// Initialize picked state from userReactions
for (const emoji of props.userReactions) {
  picked[emoji] = true
}

function visibleCount(emoji: string) {
  return counts[emoji] ?? 0
}

const displayedReactions = computed(() =>
  CHANGELOG_EMOJIS.filter(emoji => visibleCount(emoji) > 0),
)

async function toggle(emoji: string) {
  if (!isLoggedIn.value) {
    pickerOpen.value = false
    return loginModal.open()
  }

  const wasActive = picked[emoji]

  // Optimistic update
  if (wasActive) {
    picked[emoji] = false
    counts[emoji] = Math.max((counts[emoji] ?? 0) - 1, 0)
  } else {
    picked[emoji] = true
    counts[emoji] = (counts[emoji] ?? 0) + 1
  }

  try {
    let result: { reactionCounts: Record<string, number>; userReactions: string[] }

    if (wasActive) {
      result = await useApiFetch(`/api/changelogs/${props.changelogId}/reactions?emoji=${encodeURIComponent(emoji)}`, {
        method: 'DELETE',
      })
    } else {
      result = await useApiFetch(`/api/changelogs/${props.changelogId}/reactions`, {
        method: 'POST',
        body: { emoji },
      })
    }

    // Sync with server state
    Object.assign(counts, {})
    for (const [k, v] of Object.entries(result.reactionCounts)) {
      counts[k] = v
    }
    for (const e of CHANGELOG_EMOJIS) {
      picked[e] = result.userReactions.includes(e)
    }
    emit('update', result.reactionCounts, result.userReactions)
  } catch {
    // Rollback on error
    if (wasActive) {
      picked[emoji] = true
      counts[emoji] = (counts[emoji] ?? 0) + 1
    } else {
      picked[emoji] = false
      counts[emoji] = Math.max((counts[emoji] ?? 0) - 1, 0)
    }
  }
}

function toggleFromPicker(emoji: string) {
  toggle(emoji)
  pickerOpen.value = false
}

onMounted(() => {
  document.addEventListener('click', handleDocumentClick)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleDocumentClick)
})

function handleDocumentClick(event: MouseEvent) {
  if (!pickerOpen.value || !rootRef.value) return
  const target = event.target as Node | null
  if (target && !rootRef.value.contains(target)) {
    pickerOpen.value = false
  }
}
</script>

<template>
  <div ref="rootRef" class="relative flex flex-col gap-2 pt-1 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
    <div class="flex flex-wrap items-center gap-1.5 sm:gap-2">
      <button
        type="button"
        class="inline-flex min-h-10 min-w-10 items-center justify-center rounded-full border border-border bg-background px-2 py-1.5 text-muted-foreground hover:text-foreground hover:border-primary/50 active:bg-secondary/40 transition-colors touch-manipulation sm:min-h-0 sm:min-w-0 sm:px-2 sm:py-1"
        :aria-expanded="pickerOpen"
        aria-label="Add reaction"
        @click.stop="pickerOpen = !pickerOpen"
      >
        <Icon name="lucide:smile-plus" size="14" />
      </button>
      <button
        v-for="emoji in displayedReactions"
        :key="emoji"
        type="button"
        class="inline-flex min-h-10 min-w-[2.75rem] items-center justify-center gap-1.5 rounded-full border px-2.5 py-1.5 text-sm transition-colors touch-manipulation active:scale-[0.98] sm:min-h-0 sm:min-w-0 sm:py-1"
        :class="picked[emoji]
          ? 'border-primary bg-primary/12 text-foreground ring-1 ring-primary/30'
          : 'border-border bg-background text-muted-foreground hover:border-primary/50 hover:text-foreground active:bg-secondary/40'"
        @click="toggle(emoji)"
      >
        <span class="leading-none select-none">{{ emoji }}</span>
        <span class="text-xs font-heading font-bold tabular-nums">{{ visibleCount(emoji) }}</span>
      </button>
    </div>

    <div
      v-if="pickerOpen"
      class="absolute left-0 bottom-full z-20 mb-2 rounded-lg border border-border bg-popover px-2 py-2 shadow-md"
    >
      <div class="flex flex-wrap items-center gap-1">
        <button
          v-for="emoji in CHANGELOG_EMOJIS"
          :key="emoji"
          type="button"
          class="inline-flex h-8 w-8 items-center justify-center rounded-md text-lg hover:bg-secondary/70 active:bg-secondary touch-manipulation transition-colors"
          :class="picked[emoji] ? 'bg-primary/12 text-foreground ring-1 ring-primary/35' : ''"
          :aria-label="`React with ${emoji}`"
          @click="toggleFromPicker(emoji)"
        >
          {{ emoji }}
        </button>
      </div>
    </div>
  </div>
</template>
