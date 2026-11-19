export type WebSourceFailureCode = 'robots_disallowed' | 'website_unavailable' | 'content_limit' | 'service_unavailable'

const contentLimits = new Set(['page_too_large', 'content_too_large', 'page_data_too_large', 'article_too_large', 'too_many_chunks'])
const websiteFailures = new Set([
  'dns_failed', 'fetch_timeout', 'fetch_failed', 'invalid_encoding', 'invalid_redirect', 'too_many_redirects', 'redirect_outside_scope',
  'robots_unavailable', 'robots_has_no_sitemap', 'invalid_sitemap', 'discovery_limit', 'no_pages_found',
  'page_noindex', 'page_login', 'page_challenge', 'page_requires_rendering', 'page_not_ready', 'no_readable_content',
  'unsupported_content_type', 'path_excluded', 'invalid_not_modified', 'page_data_invalid_json', 'page_data_invalid_response', 'page_data_unsupported',
])

// Detailed codes stay in task/page diagnostics; only these categories reach customers.
export function webSourceFailureCode(code: string): WebSourceFailureCode {
  if (code === 'robots_disallowed') return code
  if (contentLimits.has(code) || code === 'content_limit') return 'content_limit'
  if (websiteFailures.has(code) || /^(?:http|page_data_http)_\d{3}$/.test(code) || code === 'website_unavailable') return 'website_unavailable'
  return 'service_unavailable'
}

export const webSourceFailureMessages: Record<WebSourceFailureCode, string> = {
  robots_disallowed: 'Crawling is blocked by this website.',
  website_unavailable: 'Unable to read page. Try again later.',
  content_limit: 'Page content is too long. Try another page.',
  service_unavailable: 'Sync failed. Try again later.',
}

export const WEB_SOURCE_INDEX_FAILURE_PATTERN = '^(cleanup_|provider_|service_unavailable$|sync_unavailable$|retry_exhausted$|not_configured$|invalid_response$|article_too_large$|too_many_chunks$)'
const indexFailures = new RegExp(WEB_SOURCE_INDEX_FAILURE_PATTERN)

export function webSourceFailureStage(code: string, stage?: string | null): 'fetch' | 'index' {
  if (stage === 'fetch' || stage === 'index') return stage
  return indexFailures.test(code) ? 'index' : 'fetch'
}
