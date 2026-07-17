import type { MaybeRefOrGetter } from 'vue'
import { generateExcerpt } from '#layers/feedlog/shared/utils/markdown'

// Per-page title + description, single-sourced into <title> / og: / twitter:.
// Copy has two variants on usePortalOrg().isDefault: the org name woven in, or
// generic first-person for the unnamed default org. og:image / og:site_name live in app.vue.
type OgPage =
  | { kind: 'home' }
  | { kind: 'roadmap' }
  | { kind: 'changelogList' }
  | { kind: 'post', title: MaybeRefOrGetter<string | undefined>, content: MaybeRefOrGetter<string | undefined> }
  | {
      kind: 'changelogEntry'
      title: MaybeRefOrGetter<string | undefined>
      content: MaybeRefOrGetter<string | undefined>
      publishedAt?: MaybeRefOrGetter<string | undefined>
    }

interface PageMeta {
  title: string
  description: string
  ogType: 'website' | 'article'
  publishedTime?: string
}

export function usePageOg(page: OgPage) {
  const portal = usePortalOrg()
  const { t } = useI18n()

  const meta = computed<PageMeta>(() => {
    const name = portal.value.name
    const isDefault = portal.value.isDefault

    switch (page.kind) {
      case 'home':
        return {
          title: t('seo.portalTitle', { name }),
          description: isDefault
            ? "Give us feedback, vote on feature requests, and help shape what we're building next."
            : `Give feedback to ${name}, vote on feature requests, and help shape the roadmap.`,
          ogType: 'website',
        }
      case 'roadmap':
        return {
          title: t('seo.roadmapTitle', { name }),
          description: isDefault
            ? "See what we're working on, what's planned, and what's shipped."
            : `See what ${name} is building, what's planned, and what's shipped.`,
          ogType: 'website',
        }
      case 'changelogList':
        return {
          title: t('seo.changelogTitle', { name }),
          description: isDefault
            ? 'The latest product updates, improvements, and fixes.'
            : `The latest product updates, improvements, and fixes from ${name}.`,
          ogType: 'website',
        }
      case 'post': {
        const pageTitle = (toValue(page.title) ?? '') || t('seo.postFallback')
        const body = toValue(page.content) ?? ''
        const excerpt = body ? generateExcerpt(body) : ''
        return {
          title: isDefault ? pageTitle : t('seo.titleWithOrg', { title: pageTitle, name }),
          description: excerpt || (isDefault ? 'Vote and join the discussion.' : `Vote and join the discussion on ${name}.`),
          ogType: 'article',
        }
      }
      case 'changelogEntry': {
        const pageTitle = (toValue(page.title) ?? '') || t('seo.changelogFallback')
        const body = toValue(page.content) ?? ''
        const excerpt = body ? generateExcerpt(body) : ''
        return {
          title: isDefault ? pageTitle : t('seo.titleWithOrg', { title: pageTitle, name }),
          description: excerpt || (isDefault ? "What's new." : `What's new at ${name}.`),
          ogType: 'article',
          publishedTime: toValue(page.publishedAt),
        }
      }
    }
  })

  // Passthrough template: <title> stays === og:title, and the org's portal tab
  // doesn't inherit the global "| FeedLog" suffix (dashboard keeps its default).
  useHead({ titleTemplate: '%s' })

  useSeoMeta({
    title: () => meta.value.title,
    ogTitle: () => meta.value.title,
    twitterTitle: () => meta.value.title,
    description: () => meta.value.description,
    ogDescription: () => meta.value.description,
    twitterDescription: () => meta.value.description,
    ogType: () => meta.value.ogType,
    articlePublishedTime: () => meta.value.publishedTime,
  })
}
