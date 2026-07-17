<script setup lang="ts">
const term = defineModel<string>({ default: '' })
const raw = ref('')
let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(raw, (v) => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    term.value = v.trim()
  }, 300)
})
</script>

<template>
  <div class="fl-search">
    <Icon name="lucide:search" size="15" class="fl-search__icon" />
    <input
      v-model="raw"
      type="text"
      placeholder="Search feedback…"
      autocomplete="off"
      aria-label="Search feedback"
      class="fl-search__input"
    >
    <button
      v-if="raw"
      type="button"
      aria-label="Clear search"
      class="fl-search__clear"
      @click="raw = ''"
    >
      <Icon name="lucide:x" size="14" />
    </button>
  </div>
</template>

<style scoped>
.fl-search {
  position: relative;
  width: 200px;
}
@media (min-width: 1024px) {
  .fl-search { width: 240px; }
}
.fl-search__icon {
  position: absolute;
  left: 11px;
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
  height: 36px;
  width: 100%;
  padding: 0 30px 0 32px;
  font-size: 13px;
  color: var(--foreground);
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: 10px;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.fl-search__input::placeholder {
  color: var(--muted-foreground);
}
.fl-search__input:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--primary) 14%, transparent);
}
.fl-search__clear {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  color: var(--muted-foreground);
  transition: background-color 0.15s ease, color 0.15s ease;
}
.fl-search__clear:hover {
  background: var(--muted);
  color: var(--foreground);
}

@media (prefers-reduced-motion: reduce) {
  .fl-search__icon,
  .fl-search__input,
  .fl-search__clear {
    transition: none;
  }
}
</style>
