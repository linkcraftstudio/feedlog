export type WebSourceFrequency = 'weekly' | 'biweekly' | 'monthly' | 'manual'
export type WebSourceInputType = 'website' | 'sitemap' | 'robots'
export interface WebSourceDraft {
  name: string; url: string; inputType: WebSourceInputType; frequency: WebSourceFrequency
  excludes: string; pageLimit: number; pages: { title: string; url: string }[]
}

export interface WebPageMetadata {
  title?: string
  language?: string
  content?: string
  contentHash?: string
  etag?: string
  lastModified?: string
  processorVersion?: string
  fetchMode?: 'http' | 'browser'
  externalData?: boolean
  summary?: string
  keywords?: string[]
  error?: string | null
  cleanupModel?: string
  chunkCount?: number
  indexGeneration?: string
}
