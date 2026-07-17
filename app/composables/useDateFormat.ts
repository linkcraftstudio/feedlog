export function useTimeAgo() {
  const { t } = useI18n()
  return (dateStr: string | Date): string => {
    const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
    if (seconds < 60) return t('time.justNow')
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return t('time.minutesAgo', { n: minutes })
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return t('time.hoursAgo', { n: hours })
    const days = Math.floor(hours / 24)
    if (days < 30) return t('time.daysAgo', { n: days })
    const months = Math.floor(days / 30)
    if (months < 12) return t('time.monthsAgo', { n: months })
    return t('time.yearsAgo', { n: Math.floor(months / 12) })
  }
}

export function useFormatDate() {
  const { locale } = useI18n()
  return (dateStr: string | Date): string =>
    new Date(dateStr).toLocaleDateString(locale.value === 'zh' ? 'zh-CN' : 'en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
}
