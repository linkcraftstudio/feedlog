import type { AiTrainingItem } from './ai-training'
import type { WebSourceFrequency, WebSourceInputType } from './web-source'
export interface WebsiteSyncRun {
  id: string; scope: 'full' | 'selected'; trigger: string; status: string; total: number
  added: number; updated: number; failed: number; processed?: number
  startedAt: string; finishedAt: string | null
}
export interface TrainingWebsite {
  id: string; name: string; url: string; aiEnabled: boolean; inputType: WebSourceInputType
  frequency: WebSourceFrequency; paused: boolean; excludes: string; nextRun: string | null
  status: 'ready' | 'syncing' | 'attention'
  pages: { total: number; ready: number; indexed: number; failed: number; pending: number; fetchFailed: number; indexFailed: number }
  activeRun: WebsiteSyncRun | null; lastRun: WebsiteSyncRun | null; lastFullRun: WebsiteSyncRun | null
  lastSyncedAt: string | null; lastFullSuccess: string | null
}
export interface TrainingHelpCollection { id: string; name: string; aiEnabled: boolean; articleCount: number; aiUsableCount: number }
export interface TrainingPageQuery { page: number; pageSize?: number; q?: string; status?: string }
export interface TrainingPageResult { data: AiTrainingItem[]; pagination: { page: number; pageSize: number; total: number } }
export type TrainingPageLoader = (id: string, query: TrainingPageQuery) => Promise<TrainingPageResult>

export interface TrainingHelpOverview {
  available: boolean
  collectionCount: number
  articleCount: number
  aiUsableCount: number
}
export interface AiTrainingOverview {
  sources: { help: TrainingHelpOverview; websites: TrainingWebsite[] }
}
