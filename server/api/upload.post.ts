// Keep the shared upload contract; chat applies its smaller message budget separately.
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const orgId = event.context.orgId!
  const uploadPrefix = process.env.UPLOAD_PREFIX || process.env.NUXT_PUBLIC_UPLOAD_PREFIX || useRuntimeConfig().public.uploadPrefix
  const [file] = await blobStorage.handleUpload(event, {
    formKey: 'file', multiple: false,
    ensure: { maxSize: '16MB', types: ['image'] },
    put: { addRandomSuffix: true, prefix: `${uploadPrefix}/${orgId}/` },
  })
  if (!file) throw createError({ statusCode: 400, message: 'No file provided' })
  return { key: file.pathname }
})
