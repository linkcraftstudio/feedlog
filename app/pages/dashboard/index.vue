<script setup lang="ts">
definePageMeta({
  middleware: 'admin',
  redirect: (to) => `${to.path.replace(/\/$/, '')}/feedback`,
})
</script>
