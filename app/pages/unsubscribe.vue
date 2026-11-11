<script setup lang="ts">
// /unsubscribe: the page the Unsubscribe link in an early-access mail opens
// (fresh3 23-19 follow-up; ruling R5, RFC 8058; 23-UI-SPEC.md "Unsubscribe
// page"). Opening it removes nothing: mail scanners prefetch links, so only the
// button below posts the token (POST /unsubscribe?t=, server/routes/
// unsubscribe.post.ts, which also takes the mail client's one-click POST).
// Not gated: someone on the early-access list must be able to leave it while
// the launch is closed. The token is in the query string, so the route rule
// sends no Referer and the page is never cached (nuxt.config.ts). The page
// never shows the address or the token.
import { ref } from 'vue'
import { UNSUBSCRIBE_COPY, postUnsubscribe, tokenFromQuery, type UnsubscribePhase } from '~/utils/unsubscribe-flow'

// Task page: forced light (fresh3 22-UI-SPEC Part 1, "Dark mode (Nuxt only)").
definePageMeta({ colorMode: 'light' })

const copy = UNSUBSCRIBE_COPY
const title = `${copy.title} - LocalNodes`
useSeoMeta({ title, ogTitle: title })

const token = tokenFromQuery(useRoute().query.t)
// A link with no usable token gets its message straight away, with no request.
const phase = ref<UnsubscribePhase>(token ? 'ready' : 'refused')

async function confirm() {
  if (!token || phase.value === 'working' || phase.value === 'done') return
  phase.value = 'working'
  phase.value = await postUnsubscribe(
    (url, opts) => $fetch(url, opts),
    token
  )
}
</script>

<template>
  <UContainer class="max-w-2xl py-16">
    <h1 class="text-[28px] leading-tight font-semibold text-highlighted mb-2">
      {{ copy.title }}
    </h1>
    <UnsubscribePanel :phase="phase" @confirm="confirm" />
  </UContainer>
</template>
