export interface PublicAuthConfig {
  mcp?: boolean
  google: boolean
  github: boolean
  email: boolean
  emailVerification: boolean
  emailProvider?: boolean
}

export function isAuthConfigUnavailable(
  config: PublicAuthConfig | null | undefined,
): boolean {
  return !config
}

export function isEmailAuthEnabled(config: PublicAuthConfig | null | undefined): boolean {
  return config?.email === true
}

export function useAuthConfig() {
  return useFetch<PublicAuthConfig>('/api/auth-config', {
    key: 'auth-config',
  })
}
