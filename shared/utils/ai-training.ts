import type { AiTrainingItem, AiTrainingSource } from '../types/ai-training'

export function aiTrainingAiEligible(item: AiTrainingItem) {
  return item.status === 'ready'
}

export function aiTrainingProcessingStatus(item: AiTrainingItem): 'ready' | 'indexing' | 'failed' {
  if (item.syncStatus === 'failed' || item.status === 'failed') return 'failed'
  if (item.syncStatus === 'pending' || item.syncStatus === 'processing' || item.status === 'indexing') return 'indexing'
  return 'ready'
}

export function aiTrainingMatchesIndexFilter(item: AiTrainingItem, filter: string) {
  return filter === 'all' || aiTrainingProcessingStatus(item) === filter
}

export function aiTrainingMatchesHelpPublication(item: AiTrainingItem, publication: string) {
  return publication === 'all' || (publication === 'unpublished' ? item.publicationStatus !== 'published' : item.publicationStatus === publication)
}

// Overall results use current page outcomes, never the number of retained indexes.
export function aiTrainingWebsiteStatus(source: Pick<AiTrainingSource, 'status' | 'pages'>): 'ready' | 'indexing' | 'partial' | 'failed' {
  if (source.status === 'syncing') return 'indexing'
  const pages = source.pages
  if (pages && pages.failed > 0) {
    const ready = pages.ready ?? Math.max(0, pages.total - pages.failed - pages.pending)
    return ready > 0 ? 'partial' : 'failed'
  }
  return source.status === 'attention' ? 'failed' : 'ready'
}

export function aiTrainingRunStatus(run: { status: string; failed: number; total?: number }) {
  return run.status === 'failed' && run.failed > 0 && run.failed < (run.total ?? run.failed) ? 'partial' : run.status
}
