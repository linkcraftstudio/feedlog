// `blobStorage` auto-imported from server/utils/blob.ts.

// POST /api/upload — Upload a file (requires authentication).
// Prefix the storage path with the current orgId so per-tenant uploads are
// physically separated. Read access via /api/files/* enforces the same prefix.
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const orgId = event.context.orgId!
  const uploadPrefix = process.env.UPLOAD_PREFIX || process.env.NUXT_PUBLIC_UPLOAD_PREFIX || useRuntimeConfig().public.uploadPrefix

  const [file] = await blobStorage.handleUpload(event, {
    formKey: 'file',
    multiple: false,
    ensure: {
      maxSize: '10MB',
      types: ['image'],
    },
    put: {
      addRandomSuffix: true,
      prefix: `${uploadPrefix}/${orgId}/`,
    },
  })

  if (!file) {
    throw createError({ statusCode: 400, message: 'No file provided' })
  }

  return { key: file.pathname }
})
