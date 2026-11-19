import { createHash } from 'node:crypto'
import { collectWebsitePageData } from './page-data'
import { CrawlError, type fetchWebSourceUrl, type CrawlResponse } from './fetch'
import { extractWebSourceContent, inspectWebSourcePage } from './content'
import { blocksWebSourceIndexing } from './index-policy'

export interface WebSourcePageOptions { fetcher?: typeof fetchWebSourceUrl; collectData?: boolean; dataAllows?: (url: string) => boolean }

export async function processWebSourcePage(response: CrawlResponse, options: WebSourcePageOptions = {}) {
  if (response.status >= 400) throw new CrawlError(`http_${response.status}`, response.status === 429 || response.status >= 500)
  if (!/text\/html|application\/xhtml\+xml/i.test(response.headers['content-type'] ?? 'text/html')) throw new CrawlError('unsupported_content_type')
  if (blocksWebSourceIndexing(response.headers['x-robots-tag'])) throw new CrawlError('page_noindex')
  const inspection = inspectWebSourcePage(response.body, response.url)
  const data = options.collectData ? await collectWebsitePageData(response, options.fetcher, options.dataAllows) : undefined
  const dataBacked = !!data?.canHydrate && data.candidates.length > 0
  if (inspection.needsBrowser && !dataBacked) throw new CrawlError('page_requires_rendering')
  const content = extractWebSourceContent(response.body, response.url, { allowEmpty: dataBacked })
  if (data) {
    data.requiresSelection = inspection.needsBrowser
    content.hash = createHash('sha256').update(content.hash + data.hash).digest('hex')
  }
  return { response, content: { ...content, url: response.url, data }, fetchMode: 'http' as const, dataBacked: data?.external ?? false }
}
