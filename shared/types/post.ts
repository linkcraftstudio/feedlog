// Post status enum
export const POST_STATUSES = ['open', 'planned', 'in_progress', 'done'] as const
export type PostStatus = typeof POST_STATUSES[number]

// The board's default view: work that is still live. 'done' is the only status
// a visitor has to ask for explicitly, because a finished card answers nothing
// they came to the board for.
export const ACTIVE_STATUSES = ['open', 'planned', 'in_progress'] as const

/** What the board's status control can be set to. */
export type BoardStatusFilter = 'active' | 'all' | PostStatus

/** Statuses a filter selection admits, or null for "no status condition". */
export function statusFilterToStatuses(filter: BoardStatusFilter): PostStatus[] | null {
  if (filter === 'all') return null
  if (filter === 'active') return [...ACTIVE_STATUSES]
  return [filter]
}

/**
 * Parse a `status` query value: one status name, or a comma-separated list of
 * them. Unknown names are dropped rather than rejected — a hand-written link
 * with a typo should still return a board, not a 400.
 */
export function parseStatusParam(raw: unknown): PostStatus[] {
  if (typeof raw !== 'string') return []
  return raw
    .split(',')
    .map(s => s.trim())
    .filter((s): s is PostStatus => (POST_STATUSES as readonly string[]).includes(s))
}

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
  // True = written without signing in. The UI ignores `name` in that case and
  // composes a localized label off the id instead.
  isAnonymous?: boolean
  // Optional because only the detail endpoint sets it, and only for staff.
  email?: string | null
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
  subscribed?: boolean
  author: PostAuthor
  createdAt: string
  updatedAt: string
  canonicalPost?: { slug: string; title: string }
}
