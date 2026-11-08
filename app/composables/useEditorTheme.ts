// Follow the application theme for the client-only editor shell.
export function useEditorTheme() {
  const { mode } = useThemeMode()
  const documentDark = useDocumentDark()
  const mounted = ref(false)
  onMounted(() => { mounted.value = true })

  return computed(() =>
    (mounted.value ? documentDark.value : mode.value === 'dark') ? 'dark' : 'light')
}
