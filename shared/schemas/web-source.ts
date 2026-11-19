import { z } from 'zod'

export const webSourceAddress = z.string().trim().min(1).max(2048)
export const webSourceExcludes = z.string().max(8000).default('').refine(value => value.split('\n').every(p => !p.trim() || p.trim().startsWith('/')), 'Paths must start with /')
export const webSourceDiscovery = z.object({
  url: webSourceAddress, inputType: z.enum(['website', 'sitemap', 'robots']).optional(),
  excludes: webSourceExcludes, pageLimit: z.number().int().min(1).max(1000).default(200),
})
export const webSourceInput = webSourceDiscovery.extend({
  name: z.string().trim().max(80).default(''), frequency: z.enum(['weekly', 'biweekly', 'monthly', 'manual']).default('weekly'),
  pages: z.array(z.object({ url: webSourceAddress, title: z.string().trim().max(300) })).min(1).max(1000),
})
export const webSourceSettings = z.object({ frequency: z.enum(['weekly', 'biweekly', 'monthly', 'manual']), paused: z.boolean(), excludes: webSourceExcludes })

export const webSourceBulkPages = z.object({ ids: z.array(z.uuid()).min(1).max(20000) })

export const webSourceIndividualImport = z.object({
  urls: z.array(webSourceAddress).min(1).max(1000),
  frequency: z.enum(['weekly', 'biweekly', 'monthly', 'manual']).default('weekly'),
})
