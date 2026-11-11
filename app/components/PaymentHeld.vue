<script setup lang="ts">
// The /success page while the bank asks the organizer to confirm the first
// payment (fresh3 23-37; B-1 step 5, Tom's answer 3; 23-UI-SPEC.md section 6a).
//
// - The h1 and the body, in the neutral alert look. The time is the end of the
//   hold, in the reader's own zone (Q-time); timeZone is only for tests.
// - Only for the browser that made this sign-up (canConfirm, from the status
//   reply): a plain form POST to /api/confirm-payment with the session id, and
//   one primary "Confirm my payment". The server answers that browser with a
//   303 to Stripe's payment page, so the page's address is never in this HTML,
//   for anyone. It works with scripts off. Every other session sees the h1 and
//   the body only (the email has the button too).
//
// Focus moves to the h1 when the screen appears; nothing here carries an alert
// role, so the focus move reads it once (F8).
import { computed, nextTick, onMounted, ref } from 'vue'
import { SUCCESS_COPY, heldBody } from '~/utils/reason-copy'
import { formatHeldUntil } from '#shared/billing-time'

const props = defineProps<{
  /** ISO time the hold ends (status reply). */
  heldUntil: string | null
  canConfirm: boolean
  sessionId: string
  /** Tests pin a zone; the page leaves it out, so the browser's own is used. */
  timeZone?: string
}>()

const copy = SUCCESS_COPY.held

const body = computed(() => {
  const ms = props.heldUntil ? Date.parse(props.heldUntil) : Number.NaN
  return Number.isFinite(ms) ? heldBody(formatHeldUntil(ms, props.timeZone)) : heldBody('')
})

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
      class="text-[28px] leading-tight font-semibold text-highlighted mb-8 focus:outline-none"
    >
      {{ copy.title }}
    </h1>
    <UAlert
      color="neutral"
      variant="outline"
      icon="i-lucide-info"
      :description="body"
      class="border-l-4 border-l-accented bg-default"
    />
    <form
      v-if="canConfirm"
      method="post"
      action="/api/confirm-payment"
      class="mt-8"
    >
      <input type="hidden" name="session_id" :value="sessionId">
      <UButton
        type="submit"
        :label="copy.button"
        size="xl"
        color="primary"
      />
    </form>
  </div>
</template>
