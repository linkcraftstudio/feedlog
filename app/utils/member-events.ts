// Client hook fired after the Members page changed membership (invite, cancel, remove, role, suspend,
// activate) and reloaded its lists, so a deployment can refresh state derived from it, such as seat usage.
declare module '#app' {
  interface RuntimeNuxtHooks {
    'feedlog:members:changed': () => void | Promise<void>
  }
}

export {}
