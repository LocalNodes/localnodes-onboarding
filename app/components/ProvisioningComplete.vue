<script setup lang="ts">
defineProps<{
  siteUrl: string
  loginUrl: string | null
}>()
</script>

<template>
  <div
    v-motion
    :initial="{ opacity: 0, y: 20 }"
    :enter="{ opacity: 1, y: 0, transition: { duration: 600 } }"
  >
    <UIcon name="i-lucide-sprout" class="text-primary-500 mb-6 mx-auto" size="64" />

    <h1 class="text-2xl font-bold mb-2">Your garden is ready!</h1>

    <p class="text-(--ui-text-muted) mb-4">
      Your knowledge garden at
      <a :href="siteUrl" class="text-primary-400 underline" target="_blank">{{ siteUrl }}</a>
      is live.
    </p>

    <p class="text-sm text-(--ui-text-muted) mb-8">
      Check your email for a login link to set your password.
    </p>

    <div class="flex flex-col sm:flex-row gap-3 justify-center">
      <UButton :to="siteUrl" target="_blank" size="xl" color="primary">
        Visit Your Garden
      </UButton>
      <UButton v-if="loginUrl" :to="loginUrl" target="_blank" size="xl" variant="outline">
        Set Your Password
      </UButton>
    </div>
  </div>
</template>
