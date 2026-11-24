export function handleAuthResultError(
  result: unknown,
  onError: (error: unknown) => unknown,
): boolean {
  if (!result || typeof result !== 'object' || !('error' in result)) return false
  const error = (result as { error?: unknown }).error
  if (!error) return false
  onError(error)
  return true
}
