<script setup lang="ts">
import type { AvailabilityStatus } from '~/composables/useSubdomain'

const props = defineProps<{
  subdomain: string
  availability: AvailabilityStatus
}>()

const iconName = computed(() => {
  switch (props.availability) {
    case 'checking': return 'i-lucide-loader-circle'
    case 'available': return 'i-lucide-check-circle'
    case 'taken': return 'i-lucide-x-circle'
    case 'invalid': return 'i-lucide-alert-circle'
    case 'idle':
    default: return 'i-lucide-globe'
  }
})

const colorClass = computed(() => {
  switch (props.availability) {
    case 'available': return 'text-green-500'
    case 'taken': return 'text-red-500'
    case 'invalid': return 'text-amber-500'
    default: return 'text-(--ui-text-muted)'
  }
})

const statusText = computed(() => {
  switch (props.availability) {
    case 'checking': return 'Checking...'
    case 'available': return 'Available!'
    case 'taken': return 'Already taken'
    case 'invalid': return 'Could not check'
    case 'idle':
    default: return ''
  }
})
</script>

<template>
  <div v-if="subdomain" class="flex items-center gap-2 mt-2" :class="colorClass">
    <UIcon
      :name="iconName"
      :class="[availability === 'checking' ? 'animate-spin' : '']"
      class="size-4 shrink-0"
    />
    <span class="font-mono text-sm">{{ subdomain }}</span>
    <span v-if="statusText" class="text-sm">{{ statusText }}</span>
  </div>
</template>
