// /dashboard/* gate: any org staff (owner / manager / contributor) may enter.
// Fine-grained capability checks happen inside individual pages / API calls.
export default defineNuxtRouteMiddleware(async () => {
  const { data } = await useAuthSession()

  if (!data.value?.user) {
    return navigateTo('/')
  }

  const orgList = (data.value as { orgList?: { role: string }[] }).orgList
  if (!orgList || orgList.length === 0) {
    return navigateTo('/')
  }
})
