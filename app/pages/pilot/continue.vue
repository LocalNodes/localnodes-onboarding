<script setup lang="ts">
// /pilot/continue: the page the free pilot's end mail links to (fresh3 23,
// pilot end; the server's pilot-end module). Opening it changes nothing: mail
// scanners prefetch links, so the page only reads the date, the price and the
// state (GET /api/pilot-continue), in the browser. Only the button's POST, the
// organizer's yes, keeps the site, and from then on the saved card is charged
// the full price, even while paid sign-ups are off. Not gated. The token is in
// the query string, so the route rule sends no Referer and the page is never
// cached (nuxt.config.ts). The words are draft wording, to be confirmed
// (app/utils/pilot-continue-flow.ts).
import { nextTick, onMounted, ref, watch } from 'vue'
import { PILOT_CONTINUE_COPY, callPilotContinue, pilotTokenFromQuery, type PilotContinueView } from '~/utils/pilot-continue-flow'

// Task page: forced light (fresh3 22-UI-SPEC Part 1, "Dark mode (Nuxt only)").
definePageMeta({ colorMode: 'light' })

const copy = PILOT_CONTINUE_COPY
const title = `${copy.title} - LocalNodes`
useSeoMeta({ title, ogTitle: title })

const token = pilotTokenFromQuery(useRoute().query.t)
// A link with no usable token gets its message straight away, with no request.
const view = ref<PilotContinueView>({ phase: token ? 'loading' : 'invalid', date: '', price: '' })
// The date and price from the last good read, kept when a POST fails.
const known = ref({ date: '', price: '' })
const result = ref<HTMLElement | null>(null)

const fetcher = (url: string, opts: { method: 'GET' | 'POST', query: { t: string } }) => $fetch(url, opts)

async function load() {
  if (!token) return
  view.value = { phase: 'loading', date: '', price: '' }
  const next = await callPilotContinue(fetcher, 'GET', token)
  if (next.date) known.value = { date: next.date, price: next.price }
  view.value = next
}

async function keep() {
  if (!token || view.value.phase === 'working' || view.value.phase === 'continued') return
  view.value = { ...view.value, phase: 'working' }
  const next = await callPilotContinue(fetcher, 'POST', token)
  if (next.date) known.value = { date: next.date, price: next.price }
  view.value = next
}

const isResult = (phase: string) => ['continued', 'ended', 'invalid', 'server-error'].includes(phase)
async function focusResult() {
  await nextTick()
  result.value?.focus()
}
onMounted(() => {
  if (isResult(view.value.phase)) focusResult()
  else load()
})
watch(() => view.value.phase, (now) => {
  if (isResult(now)) focusResult()
})

function retry() {
  // A read that failed reads again; a failed yes is tried again only when the read had worked.
  if (known.value.date) keep()
  else load()
}
</script>

<template>
  <UContainer class="max-w-2xl py-16">
    <h1 class="text-[28px] leading-tight font-semibold text-highlighted mb-2">
      {{ copy.title }}
    </h1>

    <!-- Always present, so the change is announced. -->
    <p aria-live="polite" class="sr-only">{{ view.phase === 'working' ? copy.buttonWorking : view.phase === 'loading' ? copy.loading : '' }}</p>

    <p v-if="view.phase === 'loading'" class="text-base text-muted">{{ copy.loading }}</p>

    <p
      v-else-if="view.phase === 'continued'"
      ref="result"
      tabindex="-1"
      class="text-base text-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >{{ copy.continued(view.date || known.date, view.price || known.price) }}</p>

    <div
      v-else-if="view.phase === 'ended' || view.phase === 'invalid'"
      ref="result"
      tabindex="-1"
      class="mt-6 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      <UAlert
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :description="view.phase === 'ended' ? copy.ended : copy.invalid"
      />
    </div>

    <div v-else class="flex flex-col gap-6">
      <template v-if="known.date">
        <p class="text-base text-default">{{ copy.ends(known.date) }}</p>
        <p class="text-base text-muted">{{ copy.cost(known.date, known.price) }}</p>
      </template>
      <div
        v-if="view.phase === 'server-error'"
        ref="result"
        tabindex="-1"
        class="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <UAlert
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :description="copy.serverError"
        />
      </div>
      <UButton
        v-if="known.date"
        type="button"
        :label="view.phase === 'working' ? copy.buttonWorking : copy.button"
        :loading="view.phase === 'working'"
        :disabled="view.phase === 'working'"
        size="xl"
        color="primary"
        class="self-start"
        @click="keep"
      />
      <UButton
        v-else-if="view.phase === 'server-error'"
        type="button"
        label="Try again"
        size="xl"
        color="neutral"
        variant="outline"
        class="self-start"
        @click="retry"
      />
    </div>
  </UContainer>
</template>
