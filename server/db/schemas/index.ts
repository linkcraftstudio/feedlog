import { pgTable, uuid, text, varchar, integer, timestamp, index, uniqueIndex, primaryKey, jsonb, customType } from 'drizzle-orm/pg-core'
import { relations, sql } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'

// Auth + organization table definitions and relations.
export {
  user,
  session,
  account,
  verification,
  organization,
  member,
  invitation,
  sessionRelations,
  accountRelations,
  organizationRelations,
  memberRelations,
  invitationRelations,
} from './auth'
import { user, session, account, organization, member, invitation } from './auth'

// Custom type for pgvector's vector column
const vector = customType<{ data: number[]; driverParam: string }>({
  dataType(config) {
    return `vector(${(config as { dimensions?: number })?.dimensions ?? 768})`
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`
  },
  fromDriver(value: string): number[] {
    return value.replace(/[\[\]]/g, '').split(',').map(Number)
  },
})

// ===== Table Definitions =====

export const board = pgTable('board', {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  orgId: text('org_id').notNull(),
  name: varchar({ length: 100 }).notNull(),
  description: text(),
  position: integer().notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  index('idx_board_org_position').on(t.orgId, t.position),
])

export const post = pgTable('post', {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  orgId: text('org_id').notNull(),
  boardId: uuid('board_id'),
  authorId: text('author_id').notNull(),
  slug: varchar({ length: 300 }).notNull(),
  status: varchar({ length: 20 }).notNull().default('open'),
  title: varchar({ length: 200 }).notNull(),
  excerpt: varchar({ length: 200 }),
  content: text().notNull(),
  voteCount: integer('vote_count').notNull().default(0),
  commentCount: integer('comment_count').notNull().default(0),
  mergedTo: uuid('merged_to'),
  contentHash: varchar('content_hash', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  // Public: All Feedback + Recent
  index('idx_post_org_created').on(t.orgId, sql`${t.createdAt} DESC`, sql`${t.id} DESC`),
  // Public: All Feedback + Top
  index('idx_post_org_votes').on(t.orgId, sql`${t.voteCount} DESC`, sql`${t.id} DESC`),
  // Public: Specific Board + Recent
  index('idx_post_org_board_created').on(t.orgId, t.boardId, sql`${t.createdAt} DESC`, sql`${t.id} DESC`),
  // Public: Specific Board + Top
  index('idx_post_org_board_votes').on(t.orgId, t.boardId, sql`${t.voteCount} DESC`, sql`${t.id} DESC`),
  // Admin: Filter by Board + Status
  index('idx_post_org_board_status').on(t.orgId, t.boardId, t.status, sql`${t.createdAt} DESC`),
  // Roadmap: Group by status + sort by votes
  index('idx_post_org_status_votes').on(t.orgId, t.status, sql`${t.voteCount} DESC`, sql`${t.id} DESC`),
  // Per-org slug uniqueness
  uniqueIndex('idx_post_org_slug').on(t.orgId, t.slug),
  // Partial index on merged_to for merged posts lookup
  index('idx_post_merged_to').on(t.mergedTo).where(sql`${t.mergedTo} IS NOT NULL`),
])

export const comment = pgTable('comment', {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  postId: uuid('post_id').notNull(),
  parentId: uuid('parent_id'),
  replyToId: uuid('reply_to_id'),
  replyCount: integer('reply_count').notNull().default(0),
  likeCount: integer('like_count').notNull().default(0),
  authorId: text('author_id').notNull(),
  content: text().notNull(),
  type: varchar({ length: 20 }).notNull().default('comment'),
  metadata: jsonb(),
  editedAt: timestamp('edited_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  // Top-level comments sorted by time (newest/oldest)
  index('idx_comment_top_level').on(t.postId, t.createdAt).where(sql`${t.parentId} IS NULL`),
  // Top-level comments sorted by likes
  index('idx_comment_top_likes').on(t.postId, sql`${t.likeCount} DESC`).where(sql`${t.parentId} IS NULL`),
  // Child comments query + eager loading
  index('idx_comment_children').on(t.postId, t.parentId, t.createdAt).where(sql`${t.parentId} IS NOT NULL`),
])

export const commentLike = pgTable('comment_like', {
  commentId: uuid('comment_id').notNull(),
  userId: text('user_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.commentId, t.userId] }),
])

export const vote = pgTable('vote', {
  postId: uuid('post_id').notNull(),
  userId: text('user_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.postId, t.userId] }),
])

export const postEmbedding = pgTable('post_embedding', {
  postId: uuid('post_id').primaryKey().references(() => post.id, { onDelete: 'cascade' }),
  orgId: text('org_id').notNull(),
  embedding: vector('embedding', { dimensions: 768 }).notNull(),
  model: varchar({ length: 50 }).notNull(),
  contentHash: varchar('content_hash', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_post_embedding_org').on(t.orgId),
])

export const postSearch = pgTable('post_search', {
  postId: uuid('post_id').primaryKey().references(() => post.id, { onDelete: 'cascade' }),
  orgId: text('org_id').notNull(),
  searchText: text('search_text').notNull(),
}, (t) => [
  index('idx_post_search_org').on(t.orgId),
])

export const changelog = pgTable('changelog', {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  orgId: text('org_id').notNull(),
  authorId: text('author_id').notNull(),
  slug: varchar({ length: 300 }).notNull(),
  status: varchar({ length: 20 }).notNull().default('draft'),
  title: varchar({ length: 70 }).notNull(),
  content: text().notNull(),
  categories: jsonb().$type<string[]>().notNull().default([]),
  cover: text(),
  publishedTitle: varchar('published_title', { length: 70 }),
  publishedContent: text('published_content'),
  publishedCategories: jsonb('published_categories').$type<string[]>(),
  publishedCover: text('published_cover'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  // Public list: cursor pagination by published_at DESC
  index('idx_changelog_org_public').on(t.orgId, sql`${t.publishedAt} DESC`, sql`${t.id} DESC`).where(sql`${t.publishedAt} IS NOT NULL`),
  // Admin list: sorted by updated_at DESC
  index('idx_changelog_org_admin').on(t.orgId, sql`${t.updatedAt} DESC`, sql`${t.id} DESC`),
  // Per-org slug uniqueness
  uniqueIndex('idx_changelog_org_slug').on(t.orgId, t.slug),
  // trgm indexes for fuzzy search
  index('idx_changelog_title_trgm').using('gist', sql`${t.title} gist_trgm_ops`),
  index('idx_changelog_content_trgm').using('gist', sql`${t.content} gist_trgm_ops`),
  index('idx_changelog_pub_title_trgm').using('gist', sql`${t.publishedTitle} gist_trgm_ops`),
  index('idx_changelog_pub_content_trgm').using('gist', sql`${t.publishedContent} gist_trgm_ops`),
])

export const changelogReaction = pgTable('changelog_reaction', {
  changelogId: uuid('changelog_id').notNull(),
  userId: text('user_id').notNull(),
  emoji: varchar({ length: 10 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.changelogId, t.userId, t.emoji] }),
])

// ===== Relations =====

// Complete user relations (auth + business, merged to avoid Drizzle conflicts)
export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  members: many(member),
  invitationsSent: many(invitation),
  posts: many(post),
  comments: many(comment),
  votes: many(vote),
  commentLikes: many(commentLike),
  changelogs: many(changelog),
  changelogReactions: many(changelogReaction),
}))

export const boardRelations = relations(board, ({ one, many }) => ({
  organization: one(organization, { fields: [board.orgId], references: [organization.id] }),
  posts: many(post),
}))

export const postRelations = relations(post, ({ one, many }) => ({
  organization: one(organization, { fields: [post.orgId], references: [organization.id] }),
  board: one(board, { fields: [post.boardId], references: [board.id] }),
  author: one(user, { fields: [post.authorId], references: [user.id] }),
  canonical: one(post, { fields: [post.mergedTo], references: [post.id], relationName: 'mergedPosts' }),
  mergedPosts: many(post, { relationName: 'mergedPosts' }),
  comments: many(comment),
  votes: many(vote),
  embedding: one(postEmbedding, { fields: [post.id], references: [postEmbedding.postId] }),
  search: one(postSearch, { fields: [post.id], references: [postSearch.postId] }),
}))

export const postEmbeddingRelations = relations(postEmbedding, ({ one }) => ({
  post: one(post, { fields: [postEmbedding.postId], references: [post.id] }),
}))

export const postSearchRelations = relations(postSearch, ({ one }) => ({
  post: one(post, { fields: [postSearch.postId], references: [post.id] }),
}))

export const commentRelations = relations(comment, ({ one, many }) => ({
  post: one(post, { fields: [comment.postId], references: [post.id] }),
  author: one(user, { fields: [comment.authorId], references: [user.id] }),
  parent: one(comment, { fields: [comment.parentId], references: [comment.id], relationName: 'commentChildren' }),
  children: many(comment, { relationName: 'commentChildren' }),
  replyTo: one(comment, { fields: [comment.replyToId], references: [comment.id], relationName: 'commentReplies' }),
  likes: many(commentLike),
}))

export const commentLikeRelations = relations(commentLike, ({ one }) => ({
  comment: one(comment, { fields: [commentLike.commentId], references: [comment.id] }),
  user: one(user, { fields: [commentLike.userId], references: [user.id] }),
}))

export const voteRelations = relations(vote, ({ one }) => ({
  post: one(post, { fields: [vote.postId], references: [post.id] }),
  user: one(user, { fields: [vote.userId], references: [user.id] }),
}))

export const changelogRelations = relations(changelog, ({ one, many }) => ({
  organization: one(organization, { fields: [changelog.orgId], references: [organization.id] }),
  author: one(user, { fields: [changelog.authorId], references: [user.id] }),
  reactions: many(changelogReaction),
}))

export const changelogReactionRelations = relations(changelogReaction, ({ one }) => ({
  changelog: one(changelog, { fields: [changelogReaction.changelogId], references: [changelog.id] }),
  user: one(user, { fields: [changelogReaction.userId], references: [user.id] }),
}))
