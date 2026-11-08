<script setup lang="ts">
definePageMeta({ middleware: 'admin' })
const { entry } = useDashboardAccess()
const localePath = useLocalePath()
await navigateTo(localePath(entry.value), { replace: true })
</script>
