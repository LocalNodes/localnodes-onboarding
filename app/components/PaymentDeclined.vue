<script setup lang="ts">
// The /success page when the first payment was declined (fresh3 23-37; B-1
// step 4; 23-UI-SPEC.md section 6b). The h1, the danger alert (the stopped
// alert's look) and one primary "Try again" to /invite: there is no free
// retry for a declined card; the invite was reopened, so a new sign-in link
// starts over. Focus moves to the h1; the alert carries no alert role (F8).
import { nextTick, onMounted, ref } from 'vue'
import { SUCCESS_COPY } from '~/utils/reason-copy'

const copy = SUCCESS_COPY.declined

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
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :description="copy.alert"
    />
    <UButton
      to="/invite"
      :label="copy.button"
      size="xl"
      color="primary"
      class="mt-8"
    />
  </div>
</template>
