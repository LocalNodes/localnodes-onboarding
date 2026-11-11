<script setup lang="ts">
// Route rules for /cancel (prerender: true) are defined in nuxt.config.ts
// Task page: forced light (fresh3 22-UI-SPEC Part 1, "Dark mode (Nuxt only)").
definePageMeta({ colorMode: 'light' })

useSeoMeta({
  title: 'Payment Cancelled - LocalNodes',
  description: 'No charges were made. You can try again whenever you are ready.',
  ogTitle: 'Payment Cancelled - LocalNodes',
  ogDescription: 'No charges were made. You can try again whenever you are ready.'
})
</script>

<template>
  <UContainer class="max-w-2xl py-16">
    <h1 class="text-[28px] leading-tight font-semibold text-highlighted mb-2">
      Payment cancelled
    </h1>

    <p class="text-base text-muted mb-8">
      No charges were made. You can try again whenever you're ready.
    </p>

    <UButton to="/onboarding" color="primary">
      Try Again
    </UButton>
  </UContainer>
</template>
