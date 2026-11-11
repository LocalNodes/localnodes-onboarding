<script setup lang="ts">
// The code field on the sign-up form (fresh3 23-19; D-06; T-3 and ruling P(a)).
// Collapsed behind "I have a code" unless the invite carries a code, in which
// case it is open and filled. "Apply code" asks POST /api/check-code (23-15),
// which gives one message for every refusal; checkout checks the code again.
// A pilot saves a card like everyone else: nothing here says otherwise.
//
// The code input carries no fixed field id, so it keeps the id its UFormField
// gives it and its label matches in the server HTML (fresh3 23-39, F2b; as
// /invite since 14b24da). Focus moves reach it through its template ref.
import { nextTick, ref, watch } from 'vue'
import { SIGNUP_COPY, applyCode } from '~/utils/onboarding-flow'

const code = defineModel<string>({ default: '' })
const props = defineProps<{
  /** True when the invite carried this code (the field starts open and filled). */
  prefilled?: boolean
  /** A refusal from checkout, shown under the field. */
  error?: string
}>()

const copy = SIGNUP_COPY.code
const open = ref(props.prefilled === true || code.value !== '')
const applying = ref(false)
const accepted = ref(false)
const message = ref('')
const codeInput = ref<{ inputRef?: HTMLInputElement | null } | null>(null)

function focusCode() {
  codeInput.value?.inputRef?.focus()
}

watch(code, () => {
  accepted.value = false
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
  const result = await applyCode(
    (url, opts) => $fetch(url, opts as Parameters<typeof $fetch>[1]) as Promise<unknown>,
    code.value.trim()
  )
  applying.value = false
  accepted.value = result.kind === 'accepted'
  message.value = result.kind === 'refused' ? result.message : ''
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
      <p v-if="accepted" role="status" class="flex items-center gap-2 text-sm text-success">
        <UIcon name="i-lucide-circle-check" class="size-4 shrink-0" aria-hidden="true" />
        {{ copy.accepted }}
      </p>
    </div>
  </div>
</template>
