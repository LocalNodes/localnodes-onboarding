<template>
  <UApp>
    <div class="min-h-screen flex items-center justify-center">
      <UPageHero
        :title="`${error?.statusCode || 500}`"
        :description="error?.statusMessage || 'Something went wrong'"
        :links="[
          { label: 'Go Home', to: '/', color: 'primary', size: 'xl' }
        ]"
      />
    </div>
  </UApp>
</template>

<script setup lang="ts">
import type { NuxtError } from '#app'

defineProps<{
  error: NuxtError
}>()
</script>
