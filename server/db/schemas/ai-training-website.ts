import { pgTable, uuid, text, integer, boolean, timestamp, index, uniqueIndex, jsonb } from 'drizzle-orm/pg-core'
import { uuidv7 } from 'uuidv7'
import type { WebPageMetadata, WebSourceFrequency, WebSourceInputType } from '../../../shared/types/web-source'

export const aiTrainingWebsite = pgTable('ai_training_website', {
  id: uuid().primaryKey().$defaultFn(uuidv7),
  orgId: text('org_id').notNull(),
  name: text().notNull().default(''),
  url: text().notNull(),
  inputType: text('input_type').$type<WebSourceInputType>().notNull().default('website'),
  aiEnabled: boolean('ai_enabled').notNull().default(true),
  frequency: text().$type<WebSourceFrequency>().notNull().default('weekly'),
  paused: boolean().notNull().default(false),
  excludes: text().notNull().default(''),
  pageLimit: integer('page_limit').notNull().default(200),
  nextRun: timestamp('next_run', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, t => [uniqueIndex('ai_training_website_org_url').on(t.orgId, t.url)])

export const aiTrainingWebsiteRun = pgTable('ai_training_website_run', {
  id: uuid().primaryKey().$defaultFn(uuidv7),
  websiteId: uuid('website_id').notNull(),
  scope: text().$type<'full' | 'selected'>().notNull(),
  trigger: text().notNull(), status: text().notNull().default('running'), total: integer().notNull(),
  added: integer().notNull().default(0), updated: integer().notNull().default(0), failed: integer().notNull().default(0),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, t => [index('ai_training_website_run_website').on(t.websiteId, t.startedAt)])

export const aiTrainingWebPage = pgTable('ai_training_web_page', {
  id: uuid().primaryKey().$defaultFn(uuidv7),
  orgId: text('org_id').notNull(),
  websiteId: uuid('website_id').notNull(),
  runId: uuid('run_id'),
  url: text().notNull(),
  metadata: jsonb().$type<WebPageMetadata>().notNull().default({}),
  attemptCount: integer('attempt_count').notNull().default(0),
  syncStatus: text('sync_status').notNull().default('pending'),
  indexedAt: timestamp('indexed_at', { withTimezone: true }),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('ai_training_web_page_website_url').on(t.websiteId, t.url), index('ai_training_web_page_org').on(t.orgId)])
