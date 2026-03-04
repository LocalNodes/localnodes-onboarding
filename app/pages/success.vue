<script setup lang="ts">
// Route rules for /success (ssr: true) are defined in nuxt.config.ts

const route = useRoute()
const sessionId = route.query.session_id as string | undefined

const {
  stages,
  isComplete,
  isFailed,
  siteUrl,
  loginUrl,
  error,
  timeRemaining
} = useProvisioningStatus(sessionId)

useSeoMeta({
  title: 'Setting Up Your Garden - LocalNodes',
  description: 'Your knowledge garden is being prepared. This takes about 4 minutes.',
  ogTitle: 'Setting Up Your Garden - LocalNodes',
  ogDescription: 'Your knowledge garden is being prepared. This takes about 4 minutes.'
})
</script>

<template>
  <UPageSection>
    <div class="max-w-md mx-auto text-center">

      <!-- WAITING STATE -->
      <template v-if="sessionId && !isComplete && !isFailed">
        <GardenAnimation class="mb-8" />

        <h1 class="text-2xl font-bold mb-2">Growing your garden...</h1>

        <p class="text-(--ui-text-muted) mb-2">
          This usually takes about 4 minutes.
        </p>

        <p class="text-xl font-mono text-primary-400 mb-8">{{ timeRemaining }}</p>

        <ProvisioningProgress :stages="stages" class="text-left mb-8" />

        <p class="text-xs text-(--ui-text-muted)">
          You'll receive a welcome email when everything is ready.
        </p>
      </template>

      <!-- SUCCESS STATE -->
      <ProvisioningComplete
        v-else-if="sessionId && isComplete"
        :site-url="siteUrl!"
        :login-url="loginUrl"
      />

      <!-- FAILURE STATE (Phase 17 will expand this) -->
      <template v-else-if="sessionId && isFailed">
        <UIcon name="i-lucide-alert-circle" class="text-red-500 mb-6 mx-auto" size="64" />

        <h1 class="text-2xl font-bold mb-2">Something went wrong</h1>

        <p class="text-(--ui-text-muted) mb-8">
          {{ error || 'Provisioning failed. Please contact support.' }}
        </p>

        <UButton to="/" variant="outline">Back to Home</UButton>
      </template>

      <!-- NO SESSION STATE -->
      <template v-else>
        <UButton to="/" variant="outline">Back to Home</UButton>
      </template>

    </div>
  </UPageSection>
</template>
