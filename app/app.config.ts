export default defineAppConfig({
  // What a suspended member can still reach, by path prefix. Layers that
  // extend FeedLog append their own entries (app.config arrays are merged).
  suspendedMemberAccess: {
    pages: ['/dashboard/members', '/dashboard/settings/members'] as string[],
    apis: [] as string[],
  },
})
