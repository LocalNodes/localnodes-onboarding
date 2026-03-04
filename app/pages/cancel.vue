<script setup lang="ts">
// Route rules for /cancel (prerender: true) are defined in nuxt.config.ts

useSeoMeta({
  title: 'Payment Cancelled - LocalNodes',
  description: 'No charges were made. You can try again whenever you are ready.',
  ogTitle: 'Payment Cancelled - LocalNodes',
  ogDescription: 'No charges were made. You can try again whenever you are ready.'
})
</script>

<template>
  <UPageSection>
    <div class="max-w-md mx-auto text-center">
      <UIcon name="i-lucide-arrow-left" class="text-(--ui-text-muted) mb-6 mx-auto" size="64" />

      <h1 class="text-2xl font-bold mb-2">
        Payment cancelled
      </h1>

      <p class="text-(--ui-text-muted) mb-8">
        No charges were made. You can try again whenever you're ready.
      </p>

      <UButton to="/onboarding" color="primary">
        Try Again
      </UButton>
    </div>
  </UPageSection>
</template>
