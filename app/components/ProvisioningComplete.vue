<script setup lang="ts">
// The /success page when the site is ready (fresh3 23-20; ONB-01, D-13;
// 23-UI-SPEC.md section 7). There is no sign-in link and no password button
// here (D-13, T-23-01): the sign-in link only ever goes by email. With no site
// address from the callback, the address line and "Open your site" give way to
// "Back to the LocalNodes home page" (the existing fallback, reworded).
import { computed, nextTick, onMounted, ref } from 'vue'
import { SUCCESS_COPY } from '~/utils/reason-copy'

const props = defineProps<{
  siteUrl: string | null
}>()

const copy = SUCCESS_COPY.welcome

/** The address as the person reads it: "repair.localnodes.xyz". */
const host = computed(() => {
  if (!props.siteUrl) return null
  try {
    return new URL(props.siteUrl).host
  } catch {
    return null
  }
})
const guideUrl = computed(() => (host.value ? `${props.siteUrl!.replace(/\/+$/, '')}/guide` : null))

// Focus moves to the h1 when this screen replaces the progress screen.
const heading = ref<HTMLElement | null>(null)
onMounted(async () => {
  await nextTick()
  heading.value?.focus()
})
</script>

<template>
  <div>
    <h1
      ref="heading"
      tabindex="-1"
      class="text-[28px] leading-tight font-semibold text-highlighted mb-4 focus:outline-none"
    >
      {{ copy.title }}
    </h1>

    <p v-if="host" class="text-base text-default mb-2">
      {{ copy.siteLine }} {{ host }}
    </p>
    <p class="text-base text-muted mb-8">
      {{ copy.signIn }}
    </p>

    <UButton
      v-if="host"
      :to="siteUrl!"
      external
      size="xl"
      color="primary"
      trailing-icon="i-lucide-external-link"
    >
      {{ copy.open }} <span class="sr-only">{{ copy.opensAnotherSite }}</span>
    </UButton>
    <p v-else>
      <ULink to="/" class="text-primary underline underline-offset-2">{{ copy.home }}</ULink>
    </p>

    <h2 class="text-xl font-semibold text-highlighted mt-12 mb-4">
      {{ copy.stepsHeading }}
    </h2>
    <ol class="list-decimal pl-6 space-y-2 text-base text-default">
      <li v-for="step in copy.steps" :key="step">
        {{ step }}
      </li>
    </ol>

    <p v-if="guideUrl" class="mt-8">
      <ULink :to="guideUrl" external class="inline-flex items-center gap-1 text-primary underline underline-offset-2">
        {{ copy.guide }} <span class="sr-only">{{ copy.opensAnotherSite }}</span>
        <UIcon name="i-lucide-external-link" class="size-4" aria-hidden="true" />
      </ULink>
    </p>
  </div>
</template>
