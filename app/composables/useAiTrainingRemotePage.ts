import type { TrainingPageLoader, TrainingPageResult } from '#layers/feedlog/shared/types/ai-training-api'

// Seed rows before expansion; page one reuses the preview prepared with the overview.
export function useAiTrainingRemotePage(input: { id: () => string; expanded: () => boolean; page: Ref<number>; query: () => string; status: () => string; revision: () => number | undefined; loader: () => TrainingPageLoader | undefined }) {
  const result = ref<TrainingPageResult>({ data: [], pagination: { page: 1, pageSize: 10, total: 0 } })
  const pending = ref(false), error = ref('')
  let sequence = 0
  let loadedKey = ''
  watch([input.id, input.page, input.query, input.status, input.revision], async () => {
    const loader = input.loader(), current = ++sequence
    if (!loader) { pending.value = false; return }
    const key = JSON.stringify([input.id(), input.page.value, input.query(), input.status(), input.revision()])
    if (key === loadedKey) { pending.value = false; return }
    pending.value = true; error.value = ''
    try {
      const next = await loader(input.id(), { page: input.page.value, q: input.query() || undefined, status: input.status() })
      if (current !== sequence) return
      const pages = Math.max(1, Math.ceil(next.pagination.total / 10))
      if (input.page.value > pages) { input.page.value = pages; return }
      result.value = next
      loadedKey = key
    } catch (failure) { if (current === sequence) error.value = aiTrainingError(failure) }
    finally { if (current === sequence) pending.value = false }
  }, { immediate: true })
  onBeforeUnmount(() => { sequence++ })
  return { result, pending, error }
}
