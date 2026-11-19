import { WEB_SOURCE_SNAPSHOT_PREFIX } from '#layers/feedlog/shared/constants/web-source'

// `blobStorage` auto-imported from server/utils/blob.ts.

// GET /api/files/** — Serve uploaded files (local dev proxy)
export default defineEventHandler(async (event) => {
  const path = getRouterParam(event, 'path')
  if (!path) {
    throw createError({ statusCode: 400, message: 'Path required' })
  }

  const normalized = decodeURIComponent(decodeURIComponent(path)).replace(/^\/+/, '')
  if (normalized.startsWith(WEB_SOURCE_SNAPSHOT_PREFIX) || normalized.split('/').includes('..')) throw createError({ statusCode: 404 })
  return blobStorage.serve(event, path)
})
