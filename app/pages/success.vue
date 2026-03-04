<script setup lang="ts">
// Route rules for /success (ssr: true) are defined in nuxt.config.ts

const route = useRoute()
const sessionId = route.query.session_id as string | undefined

useSeoMeta({
  title: 'Payment Successful - LocalNodes',
  description: 'Your knowledge garden is being prepared. You will receive a welcome email when it is ready.',
  ogTitle: 'Payment Successful - LocalNodes',
  ogDescription: 'Your knowledge garden is being prepared.'
})
</script>

<template>
  <UPageSection>
    <div class="max-w-md mx-auto text-center">
      <UIcon name="i-lucide-check-circle" class="text-green-500 mb-6 mx-auto" size="64" />

      <h1 class="text-2xl font-bold mb-2">
        Payment successful!
      </h1>

      <p class="text-(--ui-text-muted) mb-8">
        Thank you for your payment. Your knowledge garden is being prepared.
        You'll receive a welcome email when it's ready.
      </p>

      <!-- Phase 16 will add: progress/status UI here -->

      <UButton to="/" variant="outline">
        Back to Home
      </UButton>
    </div>
  </UPageSection>
</template>
