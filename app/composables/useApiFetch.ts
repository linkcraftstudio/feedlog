// SSR-safe $fetch wrapper. Forwards request cookie and host headers to
// internal /api/* calls during server-side rendering — without cookie
// forwarding, the SSR pass has no session, so authenticated routes 401
// before the page reaches the browser.
// Safe to call from store actions (outside Vue setup context).
export function useApiFetch<T>(url: string, opts?: Parameters<typeof $fetch>[1]) {
  const headers: Record<string, string> = {}

  if (import.meta.server) {
    try {
      const reqHeaders = useRequestHeaders(['cookie', 'host', 'x-forwarded-host', 'x-forwarded-proto'])
      if (reqHeaders.cookie) headers.cookie = reqHeaders.cookie
      if (reqHeaders.host) headers.host = reqHeaders.host
      if (reqHeaders['x-forwarded-host']) headers['x-forwarded-host'] = reqHeaders['x-forwarded-host']
      if (reqHeaders['x-forwarded-proto']) headers['x-forwarded-proto'] = reqHeaders['x-forwarded-proto']
    } catch {
      // Called outside Nuxt context (e.g. from store action after await),
      // header forwarding is not available — this is expected on
      // client-side navigations where headers come from the browser.
    }
  }

  return $fetch<T>(url, {
    ...opts,
    headers: { ...headers, ...opts?.headers },
  })
}
