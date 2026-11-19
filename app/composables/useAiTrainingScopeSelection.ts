import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { AiTrainingItem } from '#layers/feedlog/shared/types/ai-training'
import type { TrainingPageLoader } from '#layers/feedlog/shared/types/ai-training-api'
import type { AiTrainingSelectionState } from './useAiTrainingSelection'

// A collapsed heading selects its whole scope, independently of the visible page.
export function useAiTrainingScopeSelection(input: {
  id: () => string; items: () => AiTrainingItem[]; total: () => number
  query: () => string; status: () => string; revision: () => number | undefined
  loader: () => TrainingPageLoader | undefined; selection: AiTrainingSelectionState
}) {
  const pending = ref(false), error = ref(''), matchedTotal = ref<number | null>(null)
  let sequence = 0
  let completeItems: AiTrainingItem[] | undefined
  const checked = computed<boolean | 'mixed'>(() => {
    const count = input.items().filter(item => input.selection.selected.value.has(item.id)).length
    if (!count) return false
    return count === (matchedTotal.value ?? input.total()) ? true : 'mixed'
  })
  watch([input.id, input.query, input.status, input.revision], () => {
    sequence++; pending.value = false; matchedTotal.value = null; completeItems = undefined; error.value = ''
  })
  watch(input.selection.clearRevision, () => { sequence++; pending.value = false; error.value = '' })
  onBeforeUnmount(() => { sequence++ })
  async function choose(value: boolean) {
    const current = ++sequence, clearRevision = input.selection.clearRevision.value
    error.value = ''
    if (!value) { input.selection.chooseItems(input.items(), false); pending.value = false; return }
    // Already loaded scopes toggle synchronously; selection alone never invalidates them.
    const loaded = input.items()
    if (completeItems) {
      input.selection.chooseItems(completeItems, true)
      return
    }
    const loader = input.loader()
    if (!loader) { input.selection.chooseItems(loaded, true); return }
    pending.value = true
    const id = input.id(), query = input.query() || undefined, status = input.status()
    const currentRequest = () => current === sequence && clearRevision === input.selection.clearRevision.value
    try {
      const first = await loader(id, { page: 1, pageSize: 100, q: query, status })
      if (!currentRequest()) return
      const pages = Math.ceil(first.pagination.total / first.pagination.pageSize)
      const items = new Map(first.data.map(item => [item.id, item]))
      // Bound parallel list requests. Commit once, only after every batch succeeds.
      for (let page = 2; page <= pages; page += 4) {
        const results = await Promise.all(Array.from({ length: Math.min(4, pages - page + 1) }, (_, offset) =>
          loader(id, { page: page + offset, pageSize: first.pagination.pageSize, q: query, status })))
        if (!currentRequest()) return
        for (const result of results) {
          if (result.pagination.total !== first.pagination.total) throw new Error('The list changed. Please select all again.')
          for (const item of result.data) items.set(item.id, item)
        }
      }
      if (items.size !== first.pagination.total) throw new Error('Unable to load all matching items. Please try again.')
      matchedTotal.value = first.pagination.total
      completeItems = [...items.values()]
      input.selection.chooseItems(completeItems, true)
    } catch (failure) { if (current === sequence) error.value = aiTrainingError(failure) }
    finally { if (current === sequence) pending.value = false }
  }
  return { checked, pending, error, choose }
}
