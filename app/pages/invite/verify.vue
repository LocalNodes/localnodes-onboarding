<script setup lang="ts">
// /invite/verify: the page a sign-in link opens (fresh3 23-28, D-24, approved
// in 23-UI-SPEC.md section 2). Opening it spends nothing: mail scanners open
// links before people do, so only the button below posts the token (research
// Pitfall 2). The token sits in the fragment of the link, which the browser
// never sends to a server; this page is server-rendered with Cache-Control
// no-store and Referrer-Policy no-referrer (route rules in nuxt.config.ts).
//
// The expired or used box takes focus and carries no alert role: the focus
// move alone reads it, once (fresh3 23-39, F8; orchestrator 2026-11-08;
// 23-UI-SPEC section 2). The server-error alert takes no focus, so it keeps
// the alert role.
import { INVITE_COPY, consumeSignInLink, tokenFromHash } from '~/utils/invite-flow'

// Task page: forced light (22-UI-SPEC Part 1, "Dark mode (Nuxt only)").
definePageMeta({ colorMode: 'light' })

const copy = INVITE_COPY.verify
const title = `${copy.title} - LocalNodes`
const description = 'Continue to start setting up your community\'s site.'
useSeoMeta({ title, description, ogTitle: title, ogDescription: description })

const token = ref<string | null>(null)
const phase = ref<'ready' | 'working' | 'refused' | 'server-error'>('ready')
const announce = ref('')
const refusal = ref<HTMLElement | null>(null)

async function showRefusal() {
  phase.value = 'refused'
  await nextTick()
  refusal.value?.focus()
}

// Only in the browser: server rendering never sees the fragment. A link with no
// usable token gets the same message as a used one, and no request is made.
onMounted(() => {
  token.value = tokenFromHash(window.location.hash)
  if (!token.value) showRefusal()
})

async function proceed() {
  if (phase.value === 'working' || !token.value) return
  phase.value = 'working'
  const result = await consumeSignInLink(
    (url, opts) => $fetch(url, opts as Parameters<typeof $fetch>[1]),
    token.value
  )
  if (result === 'ok') {
    announce.value = copy.goingOn
    // A full page load: the invited state is set while the server renders a
    // page, so a client-side hop would still look uninvited and bounce (23-24).
    await navigateTo('/onboarding', { external: true })
  } else if (result === 'refused') {
    await showRefusal()
  } else {
    phase.value = 'server-error'
  }
}
</script>

<template>
  <UContainer class="max-w-2xl py-16">
    <h1 class="text-[28px] leading-tight font-semibold text-highlighted mb-2">
      {{ copy.title }}
    </h1>

    <!-- Always present, empty at first, so screen readers announce changes. -->
    <p role="status" aria-live="polite" class="sr-only">
      {{ announce }}
    </p>

    <div v-if="phase === 'refused'" class="flex flex-col gap-4 mt-6">
      <div ref="refusal" tabindex="-1" class="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
        <UAlert
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :description="copy.refused"
        />
      </div>
      <p>
        <ULink to="/invite" class="text-primary underline underline-offset-2">{{ copy.newLink }}</ULink>
      </p>
    </div>

    <div v-else class="flex flex-col gap-6">
      <p class="text-base text-muted mb-2">
        {{ copy.intro }}
      </p>
      <UAlert
        v-if="phase === 'server-error'"
        role="alert"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :description="copy.serverError"
      />
      <UButton
        type="button"
        :label="phase === 'working' ? copy.buttonWorking : copy.button"
        :loading="phase === 'working'"
        size="xl"
        color="primary"
        class="self-start"
        @click="proceed"
      />
    </div>
  </UContainer>
</template>
