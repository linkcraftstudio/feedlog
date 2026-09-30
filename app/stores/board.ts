export const useBoardStore = defineStore('board', () => {
  const boards = ref<BoardItem[]>([])

  const boardMap = computed(() => {
    const map = new Map<string, string>()
    for (const b of boards.value) {
      map.set(b.id, b.name)
    }
    return map
  })

  const totalPostCount = ref(0)

  // Statuses the counts are currently narrowed to, remembered so the refetches
  // below keep the portal's filter rather than silently widening back to "all".
  // Passing nothing clears it — which is what the dashboard pages do, since the
  // store is one instance for the whole session and their counts are unfiltered.
  const countStatuses = ref<string[] | null>(null)

  // Read
  async function fetchBoards(statuses?: string[] | null) {
    countStatuses.value = statuses?.length ? statuses : null
    const res = await useApiFetch<{ data: BoardItem[]; totalPostCount: number }>('/api/boards', {
      query: { status: countStatuses.value?.join(',') || undefined },
    })
    boards.value = res.data
    totalPostCount.value = res.totalPostCount
  }

  // Admin: create
  async function createBoard(data: { name: string; description?: string }) {
    await useApiFetch('/api/admin/boards', { method: 'POST', body: data })
    await fetchBoards(countStatuses.value)
  }

  // Admin: update
  async function updateBoard(id: string, data: { name?: string; description?: string | null }) {
    await useApiFetch(`/api/admin/boards/${id}`, { method: 'PATCH', body: data })
    await fetchBoards(countStatuses.value)
  }

  // Admin: delete
  async function deleteBoard(id: string) {
    await useApiFetch(`/api/admin/boards/${id}`, { method: 'DELETE' })
    boards.value = boards.value.filter(b => b.id !== id)
  }

  // Admin: reorder
  async function reorderBoards(ids: string[]) {
    await useApiFetch('/api/admin/boards/reorder', { method: 'PATCH', body: { ids } })
    // Reorder locally
    const ordered = ids.map((id, i) => {
      const board = boards.value.find(b => b.id === id)
      return board ? { ...board, position: i } : null
    }).filter(Boolean) as BoardItem[]
    boards.value = ordered
  }

  return {
    boards,
    boardMap,
    totalPostCount,
    fetchBoards,
    createBoard,
    updateBoard,
    deleteBoard,
    reorderBoards,
  }
})
