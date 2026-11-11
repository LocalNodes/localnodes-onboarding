<script setup lang="ts">
// The sign-up form at /onboarding (fresh3 23-19; D-02, D-06, D-20, D-21, D-24;
// T-2, T-3; rulings C and P(a); approved in 23-UI-SPEC.md section 3).
// Name and address, the invited email (read-only), a description with page
// types, the AI choice, the code, then the price line, the one primary button
// ("Continue to card details", T-3) and the line under it. Errors show on submit, in an error summary that takes
// focus, and under each field (UFormField wires aria-describedby). The server
// checks every rule again; nothing here is trusted (T-23-61).
//
// The fields carry no fixed field ids: each input keeps the id its UFormField
// gives it, so the label's for matches in the server HTML before scripts run
// (fresh3 23-39, F2b; as /invite since 14b24da). The error summary is keyed by
// the UFormField name, and a field is found by its name attribute inside this
// form. Each link's href is '#' plus the input's live id, read when the errors
// are collected (after a submit, in the browser).
import * as v from 'valibot'
import { computed, nextTick, ref } from 'vue'
import type { AiChoice, OwnKeyKind } from '#shared/ai-choice'
import { cleanTopicTypes } from '#shared/signup'
import { onboardingSchema } from '~/utils/onboarding-schema'
import { INVITE_COPY, isPlausibleEmail } from '~/utils/invite-flow'
import type { CodeOffer } from '#shared/code-offer'
import {
  SIGNUP_COPY,
  applyCode,
  browserTimeZone,
  checkoutBody,
  readPrice,
  startCheckout,
  submitLabel,
  type Fetcher
} from '~/utils/onboarding-flow'
import { decideSubmit, offersFromPrice, wordsFor, type KnownOffers } from '~/utils/offer'
import { useSubdomain } from '~/composables/useSubdomain'

/** What the server copied from the invited session during server rendering (app/plugins/invited-state.server.ts). */
interface InviteDetails { email?: string, promoCode?: string }

const copy = SIGNUP_COPY
const invite = useState<InviteDetails | null>('ln-invite-details', () => null)
const invitedEmail = computed(() => invite.value?.email ?? '')

const communityName = ref('')
const email = ref('')
const description = ref('')
const topicTypes = ref<string[]>([])
const aiChoice = ref<AiChoice>('default')
const checkedKind = ref<OwnKeyKind | null>(null)
const code = ref(invite.value?.promoCode ?? '')
const codePrefilled = Boolean(invite.value?.promoCode)

const { slug, subdomain, availability } = useSubdomain(communityName)

// The price line comes from the Stripe price on the server (23-31), read during
// server rendering so it is there with the first paint.
const price = useFetch<{ line?: string, invited?: boolean, inviteCode?: unknown }>('/api/price', { key: 'signup-price' })
const freshLine = ref<string | null>(null)
const priceLine = computed(() => freshLine.value ?? (typeof price.data.value?.line === 'string' ? price.data.value.line : ''))

// What the server has said about each code: the invite's own code arrives with
// the price, and every check adds its answer. The words follow the field's
// current value, so an answer for a code no longer in the field changes nothing.
const checked = ref<Record<string, CodeOffer>>({})
const known = computed<KnownOffers>(() => ({ ...offersFromPrice(price.data.value), ...checked.value }))
// Only an invited sign-up uses a code: the server ignores one typed in the public flow.
// The server says whether a live invited session stands behind this browser
// (with the launch open the invite details above are not filled, yet checkout
// still honours that session's code).
const codesApply = computed(() => Boolean(invitedEmail.value) || price.data.value?.invited === true)
const words = computed(() => wordsFor(code.value, known.value, codesApply.value))
const shownLine = computed(() => (words.value.kind === 'pilot' && priceLine.value) ? copy.price.pilot(words.value.months, priceLine.value) : priceLine.value)
const underLines = computed(() => {
  const w = words.value
  return w.kind === 'pilot' ? copy.submit.under.pilot(w.months) : copy.submit.under[w.kind]
})

function classified(payload: { code: string, offer: CodeOffer }) {
  checked.value = { ...checked.value, [payload.code]: payload.offer }
}

const submitting = ref(false)
const alertText = ref('')
const announce = ref('')
const errors = ref<Array<{ name: string, message: string, href: string }>>([])
const summary = ref<HTMLElement | null>(null)
const form = ref<HTMLFormElement | null>(null)

const errorFor = (name: string) => errors.value.find(e => e.name === name)?.message
const keyError = ref('')
const codeError = ref('')
const nameError = computed(() => errorFor('communityName'))
const emailError = computed(() => errorFor('email'))
const descriptionError = computed(() => errorFor('description'))
const keyFieldError = computed(() => keyError.value || errorFor('aiKey') || undefined)

const fetcher: Fetcher = (url, opts) => $fetch(url, opts as Parameters<typeof $fetch>[1]) as Promise<unknown>

async function say(text: string) {
  announce.value = ''
  await nextTick()
  announce.value = text
}

/** The input whose UFormField name is `name`, inside this form. */
function fieldNamed(name: string): HTMLElement | null {
  return form.value?.querySelector<HTMLElement>(`[name="${CSS.escape(name)}"]`) ?? null
}

function focusField(name: string) {
  fieldNamed(name)?.focus()
}

/** The submit checks, in page order. Each entry names the field its link focuses. */
function collectErrors(): Array<{ name: string, message: string, href: string }> {
  const found: Array<{ name: string, message: string }> = []
  const parsed = v.safeParse(onboardingSchema, {
    communityName: communityName.value,
    description: description.value,
    topicTypes: cleanTopicTypes(topicTypes.value),
    aiChoice: aiChoice.value,
    keyChecked: aiChoice.value !== 'default' && checkedKind.value === aiChoice.value,
    code: code.value
  })
  const issues = parsed.success ? [] : parsed.issues
  const issueAt = (key: string) => issues.find(i => i.path?.[0]?.key === key)?.message
  const name = issueAt('communityName')
  if (name) found.push({ name: 'communityName', message: name })
  else if (availability.value === 'taken') found.push({ name: 'communityName', message: copy.address.taken })
  else if (availability.value === 'invalid') found.push({ name: 'communityName', message: copy.address.invalid })
  if (!invitedEmail.value && !isPlausibleEmail(email.value)) found.push({ name: 'email', message: INVITE_COPY.entry.invalidEmail })
  const desc = issueAt('description')
  if (desc) found.push({ name: 'description', message: desc })
  const key = issueAt('keyChecked')
  if (key) found.push({ name: 'aiKey', message: key })
  return found.map(e => ({ ...e, href: `#${fieldNamed(e.name)?.id ?? ''}` }))
}

async function submit() {
  if (submitting.value) return
  alertText.value = ''
  keyError.value = ''
  codeError.value = ''
  errors.value = collectErrors()
  if (errors.value.length) {
    await nextTick()
    summary.value?.focus()
    return
  }
  if (availability.value !== 'available') return

  submitting.value = true
  // The code is checked first (the check also holds it for this sign-up). If it
  // offers something other than the words on screen, the new words show and a
  // second press continues.
  const decision = await decideSubmit({
    code: code.value,
    codesApply: codesApply.value,
    known: known.value,
    check: sent => applyCode(fetcher, sent),
    current: () => code.value
  })
  if (decision.kind === 'overtaken') {
    submitting.value = false
    return
  }
  if (decision.kind === 'stop' || decision.kind === 'show') {
    submitting.value = false
    classified({ code: decision.code, offer: decision.offer })
    if (decision.kind === 'stop') alertText.value = decision.message
    else await say([shownLine.value, ...underLines.value].filter(Boolean).join(' '))
    return
  }

  // No price on the page yet: read it again, and show it before anyone is sent to the card page.
  if (!priceLine.value) {
    const read = await readPrice(fetcher)
    submitting.value = false
    if (read.kind === 'price') {
      freshLine.value = read.line
      await say(read.line)
    } else {
      alertText.value = read.message
    }
    return
  }

  const result = await startCheckout(fetcher, checkoutBody({
    communityName: communityName.value,
    subdomain: slug.value,
    description: description.value,
    topicTypes: cleanTopicTypes(topicTypes.value),
    aiChoice: aiChoice.value,
    code: code.value,
    email: invitedEmail.value ? undefined : email.value,
    timeZone: browserTimeZone()
  }))
  if (result.kind === 'redirect') {
    await navigateTo(result.url, { external: true })
    return
  }
  submitting.value = false
  if (result.kind === 'key') {
    checkedKind.value = null
    keyError.value = result.message
    await nextTick()
    focusField('aiKey')
  } else {
    alertText.value = result.message
  }
}
</script>

<template>
  <div class="flex flex-col gap-8">
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
    />

    <div
      v-if="errors.length"
      ref="summary"
      tabindex="-1"
      class="rounded-lg border border-error p-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      <h2 class="text-base font-semibold text-error">
        {{ copy.submit.summaryHeading }}
      </h2>
      <ul class="mt-2 list-disc pl-5 text-sm">
        <li v-for="item in errors" :key="item.name">
          <a :href="item.href" class="inline-block py-1 text-error underline underline-offset-2" @click.prevent="focusField(item.name)">{{ item.message }}</a>
        </li>
      </ul>
    </div>

    <form ref="form" class="flex flex-col gap-8" novalidate @submit.prevent="submit">
      <div>
        <UFormField :label="copy.nameLabel" name="communityName" required :error="nameError">
          <UInput
            v-model="communityName"
            maxlength="50"
            size="xl"
            class="w-full"
          />
        </UFormField>
        <SubdomainPreview :subdomain="subdomain" :availability="availability" />
      </div>

      <UFormField
        :label="copy.emailLabel"
        name="email"
        :help="invitedEmail ? copy.emailHelp : undefined"
        :error="emailError"
      >
        <UInput
          v-if="invitedEmail"
          :model-value="invitedEmail"
          type="email"
          readonly
          size="xl"
          class="w-full"
        />
        <UInput
          v-else
          v-model="email"
          type="email"
          autocomplete="email"
          inputmode="email"
          size="xl"
          class="w-full"
        />
      </UFormField>

      <TopicTypesEditor
        v-model="topicTypes"
        v-model:description="description"
        :description-error="descriptionError"
      />

      <AiChoiceField
        v-model="aiChoice"
        v-model:checked-kind="checkedKind"
        :key-error="keyFieldError"
      />

      <PromoCodeField v-model="code" :prefilled="codePrefilled" :error="codeError || undefined" @classified="classified" />

      <div class="flex flex-col gap-2">
        <p v-if="priceLine" class="text-xl font-semibold text-highlighted">
          {{ shownLine }}
        </p>
        <UAlert
          v-else-if="price.error.value"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :description="copy.submit.checkoutFailed"
        />
        <UButton
          type="submit"
          :label="submitLabel(submitting)"
          :loading="submitting"
          size="xl"
          color="primary"
          class="self-start"
        />
        <p v-for="line in underLines" :key="line" class="text-sm text-muted">
          {{ line }}
        </p>
      </div>
    </form>
  </div>
</template>
