<script setup lang="ts">
defineRouteRules({ ssr: true })

useSeoMeta({
  title: 'Get Started - LocalNodes',
  description: 'Set up your community knowledge garden in minutes.',
  ogTitle: 'Get Started - LocalNodes',
  ogDescription: 'Set up your community knowledge garden in minutes.'
})
</script>

<template>
  <UPageSection>
    <div class="max-w-md mx-auto">
      <h1 class="text-2xl font-bold mb-2">
        Name your community
      </h1>
      <p class="text-(--ui-text-muted) mb-8">
        Choose a name for your knowledge garden. This will become your unique subdomain.
      </p>
      <OnboardingForm />
    </div>
  </UPageSection>
</template>
