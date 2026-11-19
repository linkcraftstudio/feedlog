import type { WebSourceFrequency, WebSourceInputType } from './web-source'

export type AiTrainingStatus = 'ready' | 'indexing' | 'failed'
export interface AiTrainingItem {
  id: string; sourceId: string; title: string; url: string; status: AiTrainingStatus
  enabled: boolean; updatedAt: string; content: string; error?: string
  indexedAt?: string | null
  lastSyncedAt?: string | null; publishedAt?: string | null
  publicationStatus?: 'draft' | 'published' | 'archived'
  collectionId?: string; collectionName?: string; collectionAiEnabled?: boolean
  indexStatus?: 'not_indexed' | 'indexing' | 'ready' | 'failed'
  syncStatus?: 'pending' | 'processing' | 'ready' | 'failed'; errorCode?: string; errorStage?: 'fetch' | 'index' | null
}
export interface AiTrainingSource {
  pages?: { total: number; ready?: number; indexed: number; pending: number; failed: number; fetchFailed?: number; indexFailed?: number }
  activeRun?: { total: number; processed?: number } | null
  lastFullSuccess?: string | null
  lastFullRun?: { status: string; scope: 'full' | 'selected' } | null
  lastRun?: { status: string; scope: 'full' | 'selected'; failed: number; total: number } | null
  id: string; name: string; url: string; kind: 'help' | 'website'
  inputType: WebSourceInputType; status: 'ready' | 'syncing' | 'attention'
  frequency: WebSourceFrequency; paused: boolean; lastSuccess: string | null; nextRun: string | null
  excludes: string; aiEnabled: boolean
  runs: { scope?: 'full' | 'selected'; id: string; startedAt: string; finishedAt?: string | null; durationSeconds?: number; total?: number; processed?: number; trigger: string; result: string; added: number; updated: number; failed: number }[]
}
