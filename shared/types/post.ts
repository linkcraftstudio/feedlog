// Post status enum
export const POST_STATUSES = ['open', 'planned', 'in_progress', 'done'] as const
export type PostStatus = typeof POST_STATUSES[number]

// Roadmap only shows these three statuses (excludes 'open')
export const ROADMAP_STATUSES = ['planned', 'in_progress', 'done'] as const
export type RoadmapStatus = typeof ROADMAP_STATUSES[number]

// Centralized status configuration
// Each status has a label and a single base color (hex).
// Badge styles (bg, text, border) are derived from this color at runtime.
export interface StatusConfig {
  label: string
  color: string // hex color, e.g. '#3b82f6'
  cssVar: string // CSS variable name prefix, e.g. '--status-planned'
}

export const STATUS_CONFIG: Record<PostStatus, StatusConfig> = {
  open: { label: 'Open', color: '#9ca3af', cssVar: '--status-open' },
  planned: { label: 'Planned', color: '#3b82f6', cssVar: '--status-planned' },
  in_progress: { label: 'In Progress', color: '#f59e0b', cssVar: '--status-in-progress' },
  done: { label: 'Completed', color: '#22c55e', cssVar: '--status-done' },
}

/** Status options as array (useful for dropdowns / selectors) */
export const STATUS_OPTIONS = POST_STATUSES.map(s => ({
  value: s,
  ...STATUS_CONFIG[s],
}))

export function statusLabelKey(status: string): string {
  return `status.${status in STATUS_CONFIG ? status : 'open'}`
}

// Compact author info for API responses
export interface PostAuthor {
  id: string
  name: string | null
  image: string | null
}

// List item (without content)
export interface PostListItem {
  id: string
  slug: string
  title: string
  excerpt: string | null
  status: string
  boardId: string | null
  voteCount: number
  commentCount: number
  mergedCount: number
  hasVoted: boolean
  author: PostAuthor
  createdAt: string
}

// Detail (includes content, excludes excerpt)
export interface PostDetail {
  id: string
  slug: string
  title: string
  content: string
  status: string
  boardId: string | null
  voteCount: number
  commentCount: number
  mergedCount: number
  mergedTo: string | null
  hasVoted: boolean
  author: PostAuthor
  createdAt: string
  updatedAt: string
  canonicalPost?: { slug: string; title: string }
}
