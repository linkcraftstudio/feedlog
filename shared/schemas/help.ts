import { z } from 'zod/v4'
import { HELP_ARTICLE_STATUSES, HELP_COLLECTION_ICONS } from '../constants/help'

const helpArticleContentSchema = z.string().refine(content => content.trim().length > 0, 'Content is required')

export const createHelpCollectionSchema = z.object({
  name: z.string().trim().min(1, 'Give the collection a name').max(100, 'Name must be 100 characters or less'),
  description: z.string().trim().max(200, 'Description must be 200 characters or less').nullable().optional(),
  icon: z.enum(HELP_COLLECTION_ICONS),
  visible: z.boolean().default(true),
})

export const updateHelpCollectionSchema = z.object({
  aiEnabled: z.boolean().optional(),
  name: z.string().trim().min(1, 'Give the collection a name').max(100, 'Name must be 100 characters or less').optional(),
  description: z.string().trim().max(200, 'Description must be 200 characters or less').nullable().optional(),
  icon: z.enum(HELP_COLLECTION_ICONS).optional(),
  visible: z.boolean().optional(),
})

export const reorderHelpCollectionSchema = z.object({
  ids: z.array(z.uuid()).min(1, 'IDs are required'),
})

export const createHelpArticleSchema = z.object({
  collectionId: z.uuid(),
  title: z.string().trim().min(1, 'Title is required').max(200, 'Title must be 200 characters or less'),
  description: z.string().trim().max(300, 'Description must be 300 characters or less').nullable().optional(),
  content: helpArticleContentSchema,
  publish: z.boolean().default(false),
  aiEnabled: z.boolean().default(true),
})

export const updateHelpArticleSchema = z.object({
  collectionId: z.uuid().optional(),
  title: z.string().trim().min(1, 'Title is required').max(200, 'Title must be 200 characters or less').optional(),
  description: z.string().trim().max(300, 'Description must be 300 characters or less').nullable().optional(),
  content: helpArticleContentSchema.optional(),
  status: z.enum(HELP_ARTICLE_STATUSES).optional(),
  aiEnabled: z.boolean().optional(),
})

export const reorderHelpArticleSchema = z.object({
  collectionId: z.uuid(),
  ids: z.array(z.uuid()).min(1, 'IDs are required'),
})

export const bulkHelpArticleSchema = z.object({
  ids: z.array(z.uuid()).min(1, 'IDs are required'),
})

export const bulkHelpAiVisibilitySchema = bulkHelpArticleSchema.extend({ aiEnabled: z.boolean() })
