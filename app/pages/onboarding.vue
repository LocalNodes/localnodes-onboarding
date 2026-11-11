<script setup lang="ts">
// /onboarding: the sign-up form, or the full-server state (fresh3 23-19; D-08,
// D-24; 23-UI-SPEC.md section 3). Route rules (ssr: true, no-store) are in
// nuxt.config.ts. The room read (GET /api/capacity, 23-17) happens during server
// rendering, so a full server shows "Waiting for Room" with no flash of the
// form and no way to pay. Anything wrong with the read counts as full.
import { computed } from 'vue'
import { SIGNUP_COPY } from '~/utils/onboarding-flow'

// Task page: forced light (fresh3 22-UI-SPEC Part 1, "Dark mode (Nuxt only)").
definePageMeta({ colorMode: 'light' })

const copy = SIGNUP_COPY
const title = `${copy.title} - LocalNodes`
useSeoMeta({ title, ogTitle: title })

const capacity = useFetch<{ room?: boolean }>('/api/capacity', { key: 'signup-capacity' })
const full = computed(() => capacity.data.value?.room !== true)
</script>

<template>
  <UContainer class="max-w-2xl py-16">
    <template v-if="full">
      <h1 class="text-[28px] leading-tight font-semibold text-highlighted mb-8">
        {{ copy.full.title }}
      </h1>
      <UAlert
        role="status"
        color="neutral"
        variant="outline"
        icon="i-lucide-info"
        :description="copy.full.alert"
        class="border-l-4 border-l-accented bg-default"
      />
    </template>
    <template v-else>
      <h1 class="text-[28px] leading-tight font-semibold text-highlighted mb-2">
        {{ copy.title }}
      </h1>
      <p class="text-base text-muted mb-8">
        {{ copy.intro }}
      </p>
      <OnboardingForm />
    </template>
  </UContainer>
</template>
