<script setup lang="ts">
// /pilot/continue: the page the free pilot's end mail links to (fresh3 23,
// pilot end; the server's pilot-end module). Opening it changes nothing: mail
// scanners prefetch links, so the page only reads the date, the price and the
// state (GET /api/pilot-continue), in the browser. Only the button's POST, the
// organizer's yes, keeps the site, and from then on the saved card is charged
// from the first bill after the free months, even while paid sign-ups are off.
// After the free end the yes opens Stripe's payment page instead, which shows
// the total; nothing is charged unless the organizer pays there, and the page
// follows only an address on Stripe's checkout host. Stripe sends them back
// here with paid=1 or back=1.
// With no readable price the page offers no yes, only a new read. Not gated. The token is in
// the query string, so the route rule sends no Referer and the page is never
// cached (nuxt.config.ts). The words are draft wording, to be confirmed
// (app/utils/pilot-continue-flow.ts).
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { PILOT_CONTINUE_COPY, callPilotContinue, pilotTokenFromQuery, type PilotContinueView } from '~/utils/pilot-continue-flow'

// Task page: forced light (fresh3 22-UI-SPEC Part 1, "Dark mode (Nuxt only)").
definePageMeta({ colorMode: 'light' })

const copy = PILOT_CONTINUE_COPY
const title = `${copy.title} - LocalNodes`
useSeoMeta({ title, ogTitle: title })

const query = useRoute().query
const token = pilotTokenFromQuery(query.t)
// Back from Stripe's payment page without paying.
const cameBack = query.back === '1'
// A link with no usable token gets its message straight away, with no request.
const view = ref<PilotContinueView>({ phase: token ? 'loading' : 'invalid', date: '', price: '' })
// The date and price from the last good read, kept when a POST fails.
const known = ref({ date: '', price: '', late: false })
const result = ref<HTMLElement | null>(null)
// The yes is offered only when the last good read had both the date and the price.
const canKeep = computed(() => Boolean(known.value.date && known.value.price))

const fetcher = (url: string, opts: { method: 'GET' | 'POST', query: { t: string } }) => $fetch(url, opts)

async function load() {
  if (!token) return
  view.value = { phase: 'loading', date: '', price: '' }
  const next = await callPilotContinue(fetcher, 'GET', token)
  if (next.date) known.value = { date: next.date, price: next.price, late: Boolean(next.late) }
  view.value = next
}

async function keep() {
  if (!token || !canKeep.value || ['working', 'checkout', 'continued'].includes(view.value.phase)) return
  view.value = { ...view.value, phase: 'working' }
  const next = await callPilotContinue(fetcher, 'POST', token)
  if (next.date) known.value = { date: next.date, price: next.price, late: Boolean(next.late) }
  view.value = next
  // callPilotContinue lets only an address on Stripe's checkout host through.
  if (next.phase === 'checkout' && next.url) window.location.assign(next.url)
}

const isResult = (phase: string) => ['continued', 'confirming', 'ended', 'invalid', 'server-error'].includes(phase)
const busy = computed(() => view.value.phase === 'working' || view.value.phase === 'checkout')
const workingLabel = computed(() => known.value.late ? copy.lateButtonWorking : copy.buttonWorking)
async function focusResult() {
  await nextTick()
  result.value?.focus()
}
onMounted(() => {
  if (isResult(view.value.phase)) focusResult()
  else load()
  // The browser's Back from Stripe's page can restore this page as it was left, mid-redirect: read again.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && view.value.phase === 'checkout') load()
  })
})
watch(() => view.value.phase, (now) => {
  if (isResult(now)) focusResult()
})

function retry() {
  // A read that failed reads again; a failed yes is tried again only when the read had a price.
  if (canKeep.value) keep()
  else load()
}
</script>

<template>
  <UContainer class="max-w-2xl py-16">
    <h1 class="text-[28px] leading-tight font-semibold text-highlighted mb-2">
      {{ copy.title }}
    </h1>

    <!-- Always present, so the change is announced. -->
    <p aria-live="polite" class="sr-only">{{ busy ? workingLabel : view.phase === 'loading' ? copy.loading : '' }}</p>

    <p v-if="view.phase === 'loading'" class="text-base text-muted">{{ copy.loading }}</p>

    <p
      v-else-if="view.phase === 'continued'"
      ref="result"
      tabindex="-1"
      class="text-base text-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >{{ view.late ? copy.lateContinued(view.charged ?? '', view.chargedOn ?? '', view.price || known.price) : copy.continued(view.price || known.price) }}</p>

    <p
      v-else-if="view.phase === 'confirming'"
      ref="result"
      tabindex="-1"
      class="text-base text-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >{{ copy.confirming }}</p>

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
      <template v-if="known.date && known.late">
        <p class="text-base text-default">{{ copy.lapsed(known.date) }}</p>
        <p v-if="cameBack" class="text-base text-default">{{ copy.back }}</p>
        <p class="text-base text-muted">{{ known.price ? copy.lateCost(known.price) : copy.priceMissing }}</p>
      </template>
      <template v-else-if="known.date">
        <p class="text-base text-default">{{ copy.ends(known.date) }}</p>
        <p class="text-base text-muted">{{ known.price ? copy.cost(known.date, known.price) : copy.priceMissing }}</p>
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
        v-if="canKeep"
        type="button"
        :label="busy ? workingLabel : copy.button"
        :loading="busy"
        :disabled="busy"
        size="xl"
        color="primary"
        class="self-start"
        @click="keep"
      />
      <UButton
        v-else-if="view.phase === 'server-error' || view.phase === 'price-missing'"
        type="button"
        :label="copy.retry"
        size="xl"
        color="neutral"
        variant="outline"
        class="self-start"
        @click="retry"
      />
    </div>
  </UContainer>
</template>
