<script setup lang="ts">
// The code field on the sign-up form (fresh3 23-19; D-06; T-3 and ruling P(a)).
// Collapsed behind "I have a code" unless the invite carries a code, in which
// case it is open and filled. "Apply code" asks POST /api/check-code (23-15),
// which gives one message for every refusal and says what the code offers;
// checkout checks the code again. The offer goes up to the form (classified),
// which words the page by it. Editing the field clears this field's applied
// state and voids any check still on its way, so a late reply for a code that
// is no longer in the field is dropped. A pilot saves a card like everyone
// else: nothing here says otherwise.
//
// The code input carries no fixed field id, so it keeps the id its UFormField
// gives it and its label matches in the server HTML (fresh3 23-39, F2b; as
// /invite since 14b24da). Focus moves reach it through its template ref.
import { computed, nextTick, ref, watch } from 'vue'
import type { CodeOffer } from '#shared/code-offer'
import { normalizeCode } from '#shared/code-offer'
import { SIGNUP_COPY, applyCode } from '~/utils/onboarding-flow'
import { createApplyGuard } from '~/utils/offer'

const code = defineModel<string>({ default: '' })
const props = defineProps<{
  /** True when the invite carried this code (the field starts open and filled). */
  prefilled?: boolean
  /** A refusal from checkout, shown under the field. */
  error?: string
}>()

const emit = defineEmits<{
  /** The server answered a check for this code (trimmed). Never emitted for a reply that arrived after the field changed. */
  classified: [payload: { code: string, offer: CodeOffer }]
}>()

const copy = SIGNUP_COPY.code
const guard = createApplyGuard()
const open = ref(props.prefilled === true || code.value !== '')
const applying = ref(false)
/** The offer of the code that was applied and is still in the field; null once the field is edited. */
const appliedOffer = ref<Extract<CodeOffer, { offer: 'pilot' | 'paid' }> | null>(null)
const acceptedText = computed(() => {
  const offer = appliedOffer.value
  if (!offer) return ''
  return offer.offer === 'pilot' ? copy.accepted.pilot(offer.months) : copy.accepted.paid
})
const message = ref('')
const codeInput = ref<{ inputRef?: HTMLInputElement | null } | null>(null)

function focusCode() {
  codeInput.value?.inputRef?.focus()
}

watch(code, () => {
  guard.invalidate()
  appliedOffer.value = null
  message.value = ''
})

async function expand() {
  open.value = true
  await nextTick()
  focusCode()
}

async function apply() {
  if (applying.value) return
  if (!code.value.trim()) {
    focusCode()
    return
  }
  applying.value = true
  const ticket = guard.begin()
  const sent = normalizeCode(code.value)
  const result = await applyCode(
    (url, opts) => $fetch(url, opts as Parameters<typeof $fetch>[1]) as Promise<unknown>,
    sent
  )
  applying.value = false
  // The field changed while the check ran: that answer is for a code that is gone.
  if (!guard.isCurrent(ticket)) return
  appliedOffer.value = result.kind === 'accepted' ? result.offer : null
  message.value = result.kind === 'refused' ? result.message : ''
  emit('classified', { code: sent, offer: result.offer })
  // The button was disabled while it worked, which dropped focus to the page.
  // A refusal takes focus to the field, whose description carries the message,
  // so it is heard; an accepted code puts focus back on the button, and the
  // status line says so (fresh3 23-29, second-model review C3 and C4).
  await nextTick()
  if (message.value) focusCode()
  else document.getElementById('promo-code-apply')?.focus()
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <UButton
      v-if="!open"
      type="button"
      variant="link"
      :label="copy.open"
      aria-expanded="false"
      aria-controls="promo-code-panel"
      class="self-start px-0"
      @click="expand"
    />
    <div v-else id="promo-code-panel" class="flex flex-col gap-3">
      <UFormField
        :label="copy.label"
        name="code"
        :help="prefilled ? copy.prefilledHelp : undefined"
        :error="message || props.error || undefined"
      >
        <div class="flex items-center gap-2">
          <UInput
            ref="codeInput"
            v-model="code"
            autocomplete="off"
            spellcheck="false"
            maxlength="64"
            class="w-full"
          />
          <UButton
            id="promo-code-apply"
            type="button"
            color="neutral"
            variant="outline"
            :label="copy.apply"
            :loading="applying"
            @click="apply"
          />
        </div>
      </UFormField>
      <p v-if="acceptedText" role="status" class="flex items-center gap-2 text-sm text-success">
        <UIcon name="i-lucide-circle-check" class="size-4 shrink-0" aria-hidden="true" />
        {{ acceptedText }}
      </p>
    </div>
  </div>
</template>
