import type { AiTrainingItem } from '#layers/feedlog/shared/types/ai-training'
import { aiTrainingAiEligible } from '#layers/feedlog/shared/utils/ai-training'

export function useAiTrainingSelection(items: () => AiTrainingItem[], canSelect: (item: AiTrainingItem) => boolean = aiTrainingAiEligible) {
  const selected = shallowRef(new Set<string>())
  const clearRevision = ref(0)
  const eligible = computed(() => items().filter(canSelect))
  const selectedItems = computed(() => eligible.value.filter(item => selected.value.has(item.id)))
  const checked = computed(() => !selectedItems.value.length ? false : selectedItems.value.length === eligible.value.length ? true : 'mixed' as const)
  function choose(id: string, value: boolean) {
    const next = new Set(selected.value)
    if (value) next.add(id); else next.delete(id)
    selected.value = next
  }
  function chooseAll(value: boolean) { clearRevision.value++; selected.value = new Set(value ? eligible.value.map(item => item.id) : []) }
  function chooseItems(items: AiTrainingItem[], value: boolean) {
    const next = new Set(selected.value)
    for (const item of items) {
      if (value && canSelect(item)) next.add(item.id)
      else next.delete(item.id)
    }
    selected.value = next
  }
  function scopeChecked(items: AiTrainingItem[]): boolean | 'mixed' {
    const allowed = items.filter(canSelect), count = allowed.filter(item => selected.value.has(item.id)).length
    return !count ? false : count === allowed.length ? true : 'mixed'
  }
  watch(eligible, allowed => {
    const ids = new Set(allowed.map(item => item.id))
    const retained = [...selected.value].filter(id => ids.has(id))
    if (retained.length !== selected.value.size) selected.value = new Set(retained)
  })
  return { selected, clearRevision, selectedItems, eligible, checked, choose, chooseAll, chooseItems, scopeChecked }
}

export type AiTrainingSelectionState = ReturnType<typeof useAiTrainingSelection>
