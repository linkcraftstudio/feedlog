// Runtime hooks around member lifecycle actions FeedLog performs itself (Better Auth's own organization hooks
// cover invitations and joins). A deployment subscribes in a Nitro plugin with nitroApp.hooks.hook(...); a hook
// that throws an H3 error aborts the action and that error is returned to the client.
export interface MemberActivateContext {
  orgId: string
  memberId: string
}

declare module 'nitropack/types' {
  interface NitroRuntimeHooks {
    /** Before a suspended member is activated again. */
    'feedlog:member:before-activate': (context: MemberActivateContext) => void | Promise<void>
  }
}

export {}
