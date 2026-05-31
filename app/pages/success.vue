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

      <!-- Branches are ordered so each only assumes what its predecessors ruled
           out, making them trivially mutually exclusive. The else-chain is also
           exhaustive: every {sessionId?, isFailed, isComplete, siteUrl?} combo
           lands in exactly one branch, and any terminal `complete` resolves to a
           success state (never the perpetual spinner). -->

      <!-- NO SESSION STATE -->
      <template v-if="!sessionId">
        <UIcon name="i-lucide-compass" class="text-(--ui-text-muted) mb-6 mx-auto" size="64" />

        <h1 class="text-2xl font-bold mb-2">Nothing to show here</h1>

        <p class="text-(--ui-text-muted) mb-8">
          No active session -- looks like you reached this page without completing checkout.
        </p>

        <UButton to="/" variant="outline">Back to Home</UButton>
      </template>

      <!-- FAILURE STATE (Phase 17 will expand this) -->
      <template v-else-if="isFailed">
        <UIcon name="i-lucide-alert-circle" class="text-red-500 mb-6 mx-auto" size="64" />

        <h1 class="text-2xl font-bold mb-2">Something went wrong</h1>

        <p class="text-(--ui-text-muted) mb-8">
          {{ error || 'Provisioning failed. Please contact support.' }}
        </p>

        <UButton to="/" variant="outline">Back to Home</UButton>
      </template>

      <!-- SUCCESS STATE (with site URL) -->
      <ProvisioningComplete
        v-else-if="isComplete && siteUrl"
        :site-url="siteUrl"
        :login-url="loginUrl"
      />

      <!-- SUCCESS STATE (complete, but the callback never sent a site_url).
           Graceful terminal success so a finished customer is never stranded on
           the "growing..." spinner -- polling has already stopped on `complete`. -->
      <template v-else-if="isComplete">
        <div
          v-motion
          :initial="{ opacity: 0, y: 20 }"
          :enter="{ opacity: 1, y: 0, transition: { duration: 600 } }"
        >
          <UIcon name="i-lucide-sprout" class="text-primary-500 mb-6 mx-auto" size="64" />

          <h1 class="text-2xl font-bold mb-2">Your garden is ready!</h1>

          <p class="text-(--ui-text-muted) mb-8">
            Check your email for your login link to get started.
          </p>

          <div class="flex flex-col sm:flex-row gap-3 justify-center">
            <UButton to="/" size="xl" color="primary">Back to Home</UButton>
            <UButton v-if="loginUrl" :to="loginUrl" target="_blank" size="xl" variant="outline">
              Set Your Password
            </UButton>
          </div>
        </div>
      </template>

      <!-- WAITING STATE -->
      <template v-else>
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

    </div>
  </UPageSection>
</template>
