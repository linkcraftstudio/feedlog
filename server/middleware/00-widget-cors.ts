// Runs first (filename order) so the headers are on the event even when a later
// middleware or the handler throws — an error the browser blocks is
// indistinguishable from a network failure to the SDK.
export default defineEventHandler((event) => {
  if (!isWidgetApiPath(event.path)) return
  applyWidgetCors(event)
  if (handleWidgetPreflight(event)) return null
})
