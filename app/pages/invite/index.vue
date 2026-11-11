<script setup lang="ts">
// /invite: an invited person types the address their invite went to and asks
// for a sign-in link (fresh3 23-28, D-01, D-24, approved in 23-UI-SPEC.md
// section 1). The page lives at invite/index.vue, not invite.vue: a page file
// next to an invite/ folder is the parent of the pages in it, and /invite/verify
// would then only show inside this page.
// The server gives one reply for every valid address (T-23-04), so the sent
// state never says whether the address is invited, and the address is never
// written back into the page text. Route rules (ssr: true) are in nuxt.config.ts.
import { INVITE_COPY, RESEND_WAIT_SECONDS, isPlausibleEmail, requestSignInLink } from '~/utils/invite-flow'

// Task page: forced light (22-UI-SPEC Part 1, "Dark mode (Nuxt only)").
definePageMeta({ colorMode: 'light' })

const copy = INVITE_COPY.entry
const title = `${copy.title} - LocalNodes`
const description = 'Ask for a sign-in link to start setting up your community\'s site.'
useSeoMeta({ title, description, ogTitle: title, ogDescription: description })

const email = ref('')
const hpField = ref('') // honeypot
const sending = ref(false)
const sent = ref(false)
const canResend = ref(false)
const emailError = ref('')
const alertText = ref('')
const announce = ref('')
const summary = ref<HTMLElement | null>(null)
// The Email input's id is the one UFormField gives it, so the server HTML's
// <label for> already matches before hydration (fresh3 23-29 finding 2: an
// explicit id on the UInput only reached the label on the client). The error
// summary's link reads the id from the input.
const emailInput = ref<{ inputRef?: HTMLInputElement | null } | null>(null)
const emailId = computed(() => emailInput.value?.inputRef?.id ?? '')
const sentHeading = ref<HTMLElement | null>(null)
let waitTimer: ReturnType<typeof setTimeout> | undefined

/** Sets the polite message; clearing first makes a repeated sentence read out again. */
async function say(text: string) {
  announce.value = ''
  await nextTick()
  announce.value = text
}

function startWait() {
  canResend.value = false
  clearTimeout(waitTimer)
  waitTimer = setTimeout(() => {
    canResend.value = true
    say(copy.resendAnnouncement)
  }, RESEND_WAIT_SECONDS * 1000)
}

onBeforeUnmount(() => clearTimeout(waitTimer))

function focusField() {
  emailInput.value?.inputRef?.focus()
}

async function submit() {
  if (sending.value) return
  emailError.value = ''
  alertText.value = ''

  const address = email.value.trim()
  if (!isPlausibleEmail(address)) {
    emailError.value = copy.invalidEmail
    await nextTick()
    summary.value?.focus()
    return
  }

  sending.value = true
  const result = await requestSignInLink(
    (url, opts) => $fetch(url, opts as Parameters<typeof $fetch>[1]),
    address,
    hpField.value
  )
  sending.value = false

  if (result.kind === 'sent') {
    sent.value = true
    startWait()
    await say(copy.sentReply)
    await nextTick()
    sentHeading.value?.focus()
  } else if (result.kind === 'invalid') {
    emailError.value = copy.invalidEmail
    await nextTick()
    summary.value?.focus()
  } else {
    alertText.value = result.kind === 'too-many' ? copy.tooManyTries : copy.serverError
  }
}
</script>

<template>
  <UContainer class="max-w-2xl py-16">
    <h1 class="text-[28px] leading-tight font-semibold text-highlighted mb-2">
      {{ copy.title }}
    </h1>
    <p class="text-base text-muted mb-8">
      {{ copy.intro }}
    </p>

    <!-- Always present, empty at first, so screen readers announce changes. -->
    <p role="status" aria-live="polite" class="sr-only">
      {{ announce }}
    </p>

    <UAlert
      v-if="alertText"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :description="alertText"
      class="mb-6"
    />

    <div
      v-if="emailError"
      ref="summary"
      tabindex="-1"
      class="mb-6 rounded-lg border border-error p-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      <h2 class="text-base font-semibold text-error">
        {{ copy.summaryHeading }}
      </h2>
      <ul class="mt-2 list-disc pl-5 text-sm">
        <li>
          <a :href="`#${emailId}`" class="text-error underline underline-offset-2" @click.prevent="focusField">{{ emailError }}</a>
        </li>
      </ul>
    </div>

    <form class="relative flex flex-col gap-6" novalidate @submit.prevent="submit">
      <UFormField :label="copy.fieldLabel" name="email" :error="emailError || undefined">
        <UInput
          ref="emailInput"
          v-model="email"
          type="email"
          autocomplete="email"
          inputmode="email"
          size="xl"
          class="w-full"
        />
      </UFormField>

      <!-- Honeypot: hidden from people, from assistive technology and from Tab; bots fill it. -->
      <div aria-hidden="true" class="absolute -left-[9999px] w-px h-px overflow-hidden">
        <label for="invite-hp">Leave this empty</label>
        <input id="invite-hp" v-model="hpField" type="text" name="hpField" tabindex="-1" autocomplete="off">
      </div>

      <UButton
        v-if="!sent"
        type="submit"
        :label="sending ? copy.buttonWorking : copy.button"
        :loading="sending"
        size="xl"
        color="primary"
        class="self-start"
      />

      <div v-else class="flex flex-col gap-3">
        <h2
          ref="sentHeading"
          tabindex="-1"
          class="text-xl font-semibold text-highlighted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {{ copy.sentHeading }}
        </h2>
        <UAlert
          color="success"
          variant="subtle"
          icon="i-lucide-circle-check"
          :description="copy.sentReply"
        />
        <p v-if="!canResend" class="text-sm text-muted">
          {{ copy.waitSentence }}
        </p>
        <UButton
          v-else
          type="submit"
          variant="link"
          :label="sending ? copy.buttonWorking : copy.resendButton"
          :loading="sending"
          class="self-start px-0"
        />
      </div>

      <p class="text-sm text-muted">
        <ULink to="/#privacy" class="text-primary underline underline-offset-2">{{ copy.helpLink }}</ULink>
      </p>
    </form>
  </UContainer>
</template>
