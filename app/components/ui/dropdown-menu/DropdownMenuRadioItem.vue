<script setup lang="ts">
import type { DropdownMenuRadioItemEmits, DropdownMenuRadioItemProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { Circle } from "lucide-vue-next"
import {
  DropdownMenuItemIndicator,
  DropdownMenuRadioItem,
  useForwardPropsEmits,
} from "reka-ui"
import { cn } from "@/lib/utils"

const props = withDefaults(defineProps<DropdownMenuRadioItemProps & { class?: HTMLAttributes["class"], indicatorPosition?: "left" | "right" }>(), { indicatorPosition: "left", class: undefined })

const emits = defineEmits<DropdownMenuRadioItemEmits>()

const delegatedProps = reactiveOmit(props, "class", "indicatorPosition")

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <DropdownMenuRadioItem
    data-slot="dropdown-menu-radio-item"
    v-bind="forwarded"
    :class="cn(
      'focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=\'size-\'])]:size-4',
      indicatorPosition === 'right' ? 'pr-8 pl-2' : undefined,
      props.class,
    )"
  >
    <span :class="cn('pointer-events-none absolute flex size-3.5 items-center justify-center', indicatorPosition === 'right' ? 'right-2' : 'left-2')">
      <DropdownMenuItemIndicator>
        <slot name="indicator-icon">
          <Circle class="size-2 fill-current" />
        </slot>
      </DropdownMenuItemIndicator>
    </span>
    <slot />
  </DropdownMenuRadioItem>
</template>
