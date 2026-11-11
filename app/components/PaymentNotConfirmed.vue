<script setup lang="ts">
// The /success page when a 3DS hold ran out without the bank's confirmation
// (fresh3 23-37; B-1 step 5; 23-UI-SPEC.md "Billing copy (B-1)", rows
// "Payment not confirmed", and 23-43 "Billing copy additions for 23-43", P3).
// Two moments, one look (23-43 Task 7):
//   - removing (removed false): the P3 h1 "Removing Your Site" while the
//     delete is not yet confirmed; the page keeps polling;
//   - removed (removed true): the approved "We've Removed Your Site", once the
//     workflow reported the app deleted or gone.
// "You weren't charged" only when the status reply's noCapture is true (P3's
// truth condition). Otherwise the alert falls back to the refund wording
// (orchestrator, round 2): P6's sentence while the refund is unproven, and P2's
// only once D2's check passed (refundProven). Every prop defaults to the safe
// side: removing, a capture not ruled out, the refund unproven.
// "Try again" goes to /invite (the invite was reopened). Focus moves to the h1
// on mount and again when removed turns true; the alert carries no alert role (F8).
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { SUCCESS_COPY } from '~/utils/reason-copy'

const props = withDefaults(defineProps<{
  removed?: boolean
  noCapture?: boolean
  refundProven?: boolean
}>(), { removed: false, noCapture: false, refundProven: false })

const title = computed(() => props.removed ? SUCCESS_COPY.notConfirmed.title : SUCCESS_COPY.removing.title)
const alert = computed(() => {
  if (props.noCapture) return props.removed ? SUCCESS_COPY.notConfirmed.alert : SUCCESS_COPY.removing.alert
  return props.refundProven ? SUCCESS_COPY.refunded.alert : SUCCESS_COPY.refunding.alert
})
const button = SUCCESS_COPY.removing.button

const heading = ref<HTMLElement | null>(null)
const focusHeading = async () => {
  await nextTick()
  heading.value?.focus()
}
onMounted(focusHeading)
watch(() => props.removed, (now, before) => {
  if (now && !before) void focusHeading()
})
</script>

<template>
  <div>
    <h1
      ref="heading"
      tabindex="-1"
      class="text-[28px] leading-tight font-semibold text-highlighted mb-8 focus:outline-none"
    >
      {{ title }}
    </h1>
    <UAlert
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :description="alert"
    />
    <UButton
      to="/invite"
      :label="button"
      size="xl"
      color="primary"
      class="mt-8"
    />
  </div>
</template>
