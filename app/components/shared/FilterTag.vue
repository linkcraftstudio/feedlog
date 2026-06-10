<script setup lang="ts">
const modelValue = defineModel<string>({ required: true })

const props = withDefaults(defineProps<{
  label: string
  icon: string
  options: { value: string; label: string }[]
  removable?: boolean
}>(), {
  removable: true,
})

defineEmits<{
  remove: []
}>()

const selectedLabel = computed(() => {
  const opt = props.options.find(o => o.value === modelValue.value)
  return opt?.label ?? modelValue.value
})
</script>

<template>
  <div class="inline-flex items-center border border-border rounded-lg overflow-hidden h-7">
    <!-- Key label -->
    <span class="px-2.5 py-1 bg-background text-[10px] font-bold text-muted-foreground border-r border-border flex items-center gap-1.5">
      <Icon :name="icon" size="14" />
      {{ label }}
    </span>
    <!-- Value dropdown -->
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <button class="px-2.5 py-1 bg-card text-primary text-[10px] font-bold flex items-center gap-1 hover:bg-background/50 transition-colors cursor-pointer">
          {{ selectedLabel }}
          <Icon name="lucide:chevron-down" size="10" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="min-w-[140px]">
        <DropdownMenuItem
          v-for="opt in options"
          :key="opt.value"
          class="cursor-pointer text-xs whitespace-nowrap"
          :class="opt.value === modelValue ? 'text-primary font-bold' : ''"
          @select="modelValue = opt.value"
        >
          <span class="w-4 shrink-0 flex items-center justify-center">
            <Icon v-if="opt.value === modelValue" name="lucide:check" size="12" />
          </span>
          {{ opt.label }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <!-- Remove button -->
    <button
      v-if="removable"
      class="px-1.5 py-1 text-muted-foreground hover:text-foreground transition-colors border-l border-border"
      @click="$emit('remove')"
    >
      <Icon name="lucide:x" size="12" />
    </button>
  </div>
</template>
