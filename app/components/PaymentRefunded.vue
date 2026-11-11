<script setup lang="ts">
// The /success page for the automatic full refund (fresh3 23-43 Task 7; Tom's
// ruling 2026-11-09; 23-UI-SPEC.md "Billing copy additions for 23-43", P2 and
// P6). Two moments:
//   - refunding (refunded false), P6: "Refunding Your Payment" in the neutral
//     alert look (the held screen's), no button; the page keeps polling. It
//     stays while a refund problem waits for a person;
//   - refunded (refunded true), P2: "We've Refunded Your Payment", the danger
//     alert (the declined screen's look) and one primary "Try again" to
//     /invite; shown only after the refund succeeded for exactly the amount
//     captured (D2); polling stops.
// With lateActivation (the site came up after the refund began) neither alert
// says the site wasn't set up: only "We're refunding your payment." or "We've
// refunded your payment in full." (the P1/P2 truth rule). Focus moves to the
// h1 on mount and again when refunded turns true; no alert role (F8).
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { SUCCESS_COPY } from '~/utils/reason-copy'

const props = withDefaults(defineProps<{
  refunded?: boolean
  lateActivation?: boolean
}>(), { refunded: false, lateActivation: false })

const copy = computed(() => props.refunded ? SUCCESS_COPY.refunded : SUCCESS_COPY.refunding)
const alert = computed(() => props.lateActivation ? copy.value.lateAlert : copy.value.alert)

const heading = ref<HTMLElement | null>(null)
const focusHeading = async () => {
  await nextTick()
  heading.value?.focus()
}
onMounted(focusHeading)
watch(() => props.refunded, (now, before) => {
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
      {{ copy.title }}
    </h1>
    <template v-if="refunded">
      <UAlert
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :description="alert"
      />
      <UButton
        to="/invite"
        :label="SUCCESS_COPY.refunded.button"
        size="xl"
        color="primary"
        class="mt-8"
      />
    </template>
    <UAlert
      v-else
      color="neutral"
      variant="outline"
      icon="i-lucide-info"
      :description="alert"
      class="border-l-4 border-l-accented bg-default"
    />
  </div>
</template>
