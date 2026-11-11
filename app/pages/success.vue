<script setup lang="ts">
// /success: progress, failure and retry, stopped, the first payment's held
// and declined screens (23-37, B-1), and welcome (fresh3 23-20; ONB-01,
// ONB-02, D-13, D-15, T-3; 23-UI-SPEC.md sections 4 to 7), and the refund and
// removal screens (23-43 Task 7: removing, refunding, refunded). Route rules
// for /success (ssr: true) are in nuxt.config.ts. Every word comes from
// app/utils/reason-copy.ts. There is no sign-in link anywhere on this page
// (D-13): the sign-in link only ever goes by email.
import { computed, ref, watch } from 'vue'
import { SUCCESS_COPY, pageTitle } from '~/utils/reason-copy'

// Task page: forced light (fresh3 22-UI-SPEC Part 1, "Dark mode (Nuxt only)").
definePageMeta({ colorMode: 'light' })

const route = useRoute()
const sessionId = route.query.session_id as string | undefined

const {
  stages,
  activeStageLabel,
  isComplete,
  isFailed,
  isHeld,
  isDeclined,
  heldUntil,
  canConfirm,
  heldExpired,
  removed,
  noCapture,
  refundProven,
  lateActivation,
  isRefunding,
  isRefunded,
  notFound,
  siteUrl,
  reason,
  canRetry,
  stopped,
  attempt,
  readError,
  retrying,
  retryFailed,
  retried,
  retry
} = useProvisioningStatus(sessionId)

const progress = SUCCESS_COPY.progress

/** A declined card (6b). A 3DS hold that ran out has its own screen (Q-held-expiry). */
const showDeclined = computed(() => isDeclined.value && !heldExpired.value)

/** A 3DS hold that ran out whose delete is not yet confirmed (23-43 Task 7, P3). */
const removing = computed(() => isDeclined.value && heldExpired.value && !removed.value)

/**
 * The empty state: no session id, or one the server does not know (a typo, an
 * old link, an expired sign-up; 23-20 follow-up). Never the build steps.
 */
const empty = computed(() => !sessionId || notFound.value)

const title = computed(() => {
  if (empty.value) return pageTitle(progress.emptyTitle)
  if (showDeclined.value) return pageTitle(SUCCESS_COPY.declined.title)
  if (removing.value) return pageTitle(SUCCESS_COPY.removing.title)
  if (isDeclined.value && heldExpired.value) return pageTitle(SUCCESS_COPY.notConfirmed.title)
  if (isRefunding.value) return pageTitle(SUCCESS_COPY.refunding.title)
  if (isRefunded.value) return pageTitle(SUCCESS_COPY.refunded.title)
  if (isHeld.value) return pageTitle(SUCCESS_COPY.held.title)
  if (stopped.value) return pageTitle(SUCCESS_COPY.stopped.title)
  if (isComplete.value) return pageTitle(SUCCESS_COPY.welcome.title)
  return pageTitle(progress.title)
})
useSeoMeta({ title, ogTitle: title })

// The one polite live region: the step name when it changes ("Setting up your
// server."), and "Retrying site setup." when the retry is pressed. Never the
// time line or a percentage (23-UI-SPEC section 4). The payment outcomes
// (declined, refunding, refunded) are no step: nothing is announced for them.
const announcement = ref('')
watch(activeStageLabel, (label) => {
  if (!isFailed.value && !isDeclined.value && !isRefunding.value && !isRefunded.value) announcement.value = `${label}.`
})
watch(retrying, (now) => {
  if (now) announcement.value = SUCCESS_COPY.failed.retryingAnnouncement
})
</script>

<template>
  <UContainer class="max-w-2xl py-16">
    <p aria-live="polite" class="sr-only">
      {{ announcement }}
    </p>

    <!-- Each branch only assumes what the ones before it ruled out. The first
         payment's screens come first (23-37): declined, removing, removed (not
         confirmed), refunding, refunded (23-43 Task 7), then held. Then a
         stopped sign-up; a failure comes before complete; any complete lands
         on the welcome, with or without a site address. -->

    <!-- No session, or a session id the server does not know -->
    <!-- Written out, not through empty, so the branches below see sessionId as a string. -->
    <template v-if="!sessionId || notFound">
      <h1 class="text-[28px] leading-tight font-semibold text-highlighted mb-2">
        {{ progress.emptyTitle }}
      </h1>
      <p class="text-base text-muted mb-8">
        {{ progress.emptyBody }}
      </p>
      <ULink to="/" class="text-primary underline underline-offset-2">{{ progress.emptyLink }}</ULink>
    </template>

    <!-- The first payment was declined (6b) -->
    <PaymentDeclined v-else-if="showDeclined" />

    <!-- The 3DS hold ran out unconfirmed: the delete is not yet confirmed (23-43, P3) -->
    <PaymentNotConfirmed
      v-else-if="removing"
      :removed="false"
      :no-capture="noCapture"
      :refund-proven="refundProven"
    />

    <!-- The 3DS hold ran out unconfirmed and the site was removed (Q-held-expiry) -->
    <PaymentNotConfirmed
      v-else-if="isDeclined && heldExpired"
      :removed="true"
      :no-capture="noCapture"
      :refund-proven="refundProven"
    />

    <!-- The automatic refund is in progress (23-43, P6) -->
    <PaymentRefunded
      v-else-if="isRefunding"
      :refunded="false"
      :late-activation="lateActivation"
    />

    <!-- The refund succeeded for the amount captured (23-43, P2) -->
    <PaymentRefunded
      v-else-if="isRefunded"
      :refunded="true"
      :late-activation="lateActivation"
    />

    <!-- The bank asks for confirmation (6a); the form only for the browser that made the sign-up -->
    <PaymentHeld
      v-else-if="isHeld"
      :held-until="heldUntil"
      :can-confirm="canConfirm"
      :session-id="sessionId"
    />

    <!-- Failed, retrying or stopped -->
    <ProvisioningFailed
      v-else-if="stopped || isFailed"
      :reason="reason"
      :can-retry="canRetry"
      :stopped="stopped"
      :attempt="attempt"
      :retrying="retrying"
      :retry-failed="retryFailed"
      @retry="retry"
    />

    <!-- Welcome -->
    <ProvisioningComplete v-else-if="isComplete" :site-url="siteUrl" />

    <!-- Waiting -->
    <template v-else>
      <GardenAnimation class="mb-8" />

      <h1 class="text-[28px] leading-tight font-semibold text-highlighted mb-2">
        {{ progress.title }}
      </h1>
      <p class="text-base text-muted mb-8">
        {{ retried ? progress.retriedIntro : progress.intro }}
      </p>

      <UAlert
        v-if="readError"
        color="neutral"
        variant="outline"
        icon="i-lucide-info"
        :description="progress.readError"
        class="mb-8 border-l-4 border-l-accented bg-default"
      />

      <ProvisioningProgress :stages="stages" class="mb-8" />

      <p class="text-sm text-muted">
        {{ progress.underSteps }}
      </p>
    </template>
  </UContainer>
</template>
