// Notification system — the two notification type keys. Recipients are resolved
// from post_subscription (server/utils/notifications.ts), not a per-type audience.

export const NOTIFICATION_TYPE_KEYS = [
  'post.status_changed',
  'post.admin_replied',
] as const
export type NotificationTypeKey = (typeof NOTIFICATION_TYPE_KEYS)[number]
