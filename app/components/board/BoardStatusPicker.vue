<script setup lang="ts">
// Status filter for the public board. Sits beside the Top/Recent switch and
// reads as one of that pair — same height, same 12px radius as .fl-toolbtn.
const filter = defineModel<BoardStatusFilter>({ default: 'active' })

// 'active' and 'all' are views rather than statuses, so they lead; the four real
// statuses follow the separator in roadmap order.
const VIEWS: BoardStatusFilter[] = ['active', 'all']

function labelKey(value: BoardStatusFilter): string {
  return value === 'active' || value === 'all'
    ? `board.status${value === 'active' ? 'Active' : 'All'}`
    : statusLabelKey(value)
}

// The trigger's dot colours only make sense for a single status; the two views
// span several, so they get the neutral filter icon instead.
const activeCssVar = computed(() => (
  filter.value === 'active' || filter.value === 'all'
    ? null
    : STATUS_CONFIG[filter.value].cssVar
))
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <button
        type="button"
        class="fl-toolbtn fl-toolbtn--status"
        :class="{ 'fl-toolbtn--on': filter !== 'active' }"
        :aria-label="$t('board.statusFilter')"
      >
        <span
          v-if="activeCssVar"
          class="fl-dot"
          :style="{ backgroundColor: `var(${activeCssVar})` }"
        />
        <Icon v-else name="lucide:list-filter" size="18" />
        <span class="hidden sm:inline">{{ $t(labelKey(filter)) }}</span>
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="w-44">
      <DropdownMenuItem
        v-for="v in VIEWS"
        :key="v"
        class="cursor-pointer"
        @click="filter = v"
      >
        <span class="flex-1">{{ $t(labelKey(v)) }}</span>
        <Icon v-if="filter === v" name="lucide:check" size="14" class="text-primary" />
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        v-for="s in POST_STATUSES"
        :key="s"
        class="cursor-pointer"
        @click="filter = s"
      >
        <span class="fl-dot" :style="{ backgroundColor: `var(${STATUS_CONFIG[s].cssVar})` }" />
        <span class="flex-1">{{ $t(statusLabelKey(s)) }}</span>
        <Icon v-if="filter === s" name="lucide:check" size="14" class="text-primary" />
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>

<style scoped>
/* Mirrors .fl-toolbtn in BoardSearchToolbar — scoped styles do not reach across
   components, so the shape is repeated rather than shared. */
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
  white-space: nowrap;
  transition: border-color 0.15s ease, color 0.15s ease;
}
.fl-toolbtn:hover {
  border-color: var(--primary);
  color: var(--foreground);
}

/* Any selection other than the default is a state the visitor should be able to
   spot without opening the menu. */
.fl-toolbtn--on {
  border-color: var(--primary);
  color: var(--foreground);
}

.fl-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  flex: none;
}

@media (max-width: 639.98px) {
  .fl-toolbtn--status {
    width: 40px;
    padding: 0;
    gap: 0;
    justify-content: center;
  }
}

@media (prefers-reduced-motion: reduce) {
  .fl-toolbtn {
    transition: none;
  }
}
</style>
