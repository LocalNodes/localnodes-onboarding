<script setup lang="ts">
// The /success page when the build failed (fresh3 23-20; ONB-02, D-15, D-17,
// T-3, ruling C; 23-UI-SPEC.md sections 5 and 6). Build failures only: no
// payment wording here (the declined-card, 3DS and paused states wait on B-1).
//
// - Failed with a retry offered: the danger alert (icon and words, the reason
//   sentence), the line under it and one primary "Retry site setup".
// - Failed with no retry and not yet stopped (a site's own failure inside its
//   10-minute window, or a stop still running; 23-14): the alert, and on
//   attempt 2 the next-step line (SUCCESS_COPY.failed.nextStep) under it, in
//   the retry line's slot (23-38; true because the QStash sweep runs the stop
//   when no one reads the status). On attempt 1 the window ends in the free
//   retry, with no mail, so it shows the alert only (ruling point 1 (c),
//   2026-11-08).
// - Stopped: section 6, read from the status reply's stopped key, so a reload
//   shows the same. No retry.
// The reason code itself is never shown (T-23-01); only its sentence is.
//
// The failure box takes focus and carries no alert role: the focus move alone
// reads it, once (fresh3 23-39, F8; orchestrator 2026-11-08; 23-UI-SPEC
// section 5). The stopped alert (focus goes to its h1) and the retry-request
// alert (the button comes back) take no focus, so they keep the alert role.
import { nextTick, onMounted, ref, watch } from 'vue'
import { SUCCESS_COPY, reasonSentence } from '~/utils/reason-copy'

const props = withDefaults(defineProps<{
  reason: string | null
  canRetry: boolean
  stopped: boolean
  retrying: boolean
  retryFailed: boolean
  /** 1 for the first build, 2 after the free retry (status reply, 23-38). */
  attempt?: number
}>(), { attempt: 1 })

const emit = defineEmits<{ retry: [] }>()

const failed = SUCCESS_COPY.failed
const stoppedCopy = SUCCESS_COPY.stopped

const alertBox = ref<HTMLElement | null>(null)
const stoppedHeading = ref<HTMLElement | null>(null)

// Focus moves to the alert when the failure first appears, and to the new h1
// when the stop replaces it (22-UI-SPEC Part 3 focus rules).
async function focusCurrent() {
  await nextTick()
  if (props.stopped) stoppedHeading.value?.focus()
  else alertBox.value?.focus()
}
onMounted(focusCurrent)
watch(() => props.stopped, (now, before) => {
  if (now && !before) focusCurrent()
})
</script>

<template>
  <div v-if="stopped">
    <h1
      ref="stoppedHeading"
      tabindex="-1"
      class="text-[28px] leading-tight font-semibold text-highlighted mb-8 focus:outline-none"
    >
      {{ stoppedCopy.title }}
    </h1>
    <div role="alert">
      <UAlert
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :description="stoppedCopy.alert"
      />
    </div>
    <p class="mt-4 text-base text-muted">
      {{ stoppedCopy.line }}
    </p>
    <p class="mt-8">
      <ULink to="/" class="text-primary underline underline-offset-2">{{ stoppedCopy.home }}</ULink>
    </p>
  </div>

  <div v-else>
    <h1 class="text-[28px] leading-tight font-semibold text-highlighted mb-8">
      {{ failed.title }}
    </h1>
    <div
      ref="alertBox"
      tabindex="-1"
      class="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      <UAlert
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
      >
        <template #description>
          <p class="font-semibold">
            {{ failed.alert }}
          </p>
          <p>{{ reasonSentence(reason) }}</p>
        </template>
      </UAlert>
    </div>
    <p v-if="!canRetry && attempt === 2" class="mt-4 text-base text-muted">
      {{ failed.nextStep }}
    </p>
    <template v-if="canRetry">
      <p class="mt-4 text-base text-muted">
        {{ failed.retryLine }}
      </p>
      <div v-if="retryFailed" role="alert" class="mt-6">
        <UAlert
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :description="failed.retryFailed"
        />
      </div>
      <UButton
        type="button"
        :label="retrying ? failed.retrying : failed.retry"
        :loading="retrying"
        :disabled="retrying"
        size="xl"
        color="primary"
        class="mt-6"
        @click="emit('retry')"
      />
    </template>
  </div>
</template>
