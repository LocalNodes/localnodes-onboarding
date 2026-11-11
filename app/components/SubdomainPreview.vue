<script setup lang="ts">
import { computed } from 'vue'
import type { AvailabilityStatus } from '~/composables/useSubdomain'
import { SIGNUP_COPY } from '~/utils/onboarding-flow'

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
    case 'available': return 'text-success'
    case 'taken': return 'text-error'
    case 'invalid': return 'text-warning'
    default: return 'text-(--ui-text-muted)'
  }
})

// The status words are 23-UI-SPEC.md section 3, row "Address preview" (23-19).
const statusText = computed(() => {
  switch (props.availability) {
    case 'checking': return SIGNUP_COPY.address.checking
    case 'available': return SIGNUP_COPY.address.available
    case 'taken': return SIGNUP_COPY.address.taken
    case 'invalid': return SIGNUP_COPY.address.invalid
    case 'idle':
    default: return ''
  }
})

// "Available" and "Taken" are announced politely; "Checking…" is not.
const announced = computed(() => props.availability === 'available' || props.availability === 'taken' ? statusText.value : '')
</script>

<template>
  <div>
    <p role="status" aria-live="polite" class="sr-only">
      {{ announced }}
    </p>
    <div v-if="subdomain" class="flex items-center gap-2 mt-2" :class="colorClass">
      <UIcon
        :name="iconName"
        :class="[availability === 'checking' ? 'animate-spin' : '']"
        class="size-4 shrink-0"
        aria-hidden="true"
      />
      <span class="font-mono text-sm">{{ subdomain }}</span>
      <span v-if="statusText" class="text-sm">{{ statusText }}</span>
    </div>
  </div>
</template>
