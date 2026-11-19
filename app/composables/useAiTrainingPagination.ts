export function useAiTrainingPagination<T>(items: () => T[], clamp: () => boolean = () => true) {
  const pageSize = 10
  const page = ref(1)
  const pageCount = computed(() => Math.max(1, Math.ceil(items().length / pageSize)))
  watch(pageCount, count => { if (clamp()) page.value = Math.min(page.value, count) })
  const pageItems = computed(() => items().slice((page.value - 1) * pageSize, page.value * pageSize))
  return { page, pageCount, pageItems }
}
