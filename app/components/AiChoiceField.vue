<script setup lang="ts">
// The AI choice on the sign-up form (fresh3 23-19; D-19, D-21; approved in
// 23-UI-SPEC.md section 3 and its "Secret field" component). Words come from
// shared/ai-choice.ts (23-18). An own key is checked once by POST /api/ai-key;
// after a good check the field is gone, the value is cleared from this
// component at once, and only the "Key checked" badge shows. The key is never
// put back into the page, a message or the address bar (T-23-60).
//
// The key input carries no fixed field id, so it keeps the id its UFormField
// gives it and its label matches in the server HTML (fresh3 23-39, F2b; as
// /invite since 14b24da). Focus moves reach it through its template ref.
import { computed, nextTick, ref, watch } from 'vue'
import {
  AI_CHOICE_COPY,
  GEMINI_BILLING_MESSAGE,
  KEY_FAILED_MESSAGE,
  aiChoiceNotes,
  type AiChoice,
  type OwnKeyKind
} from '#shared/ai-choice'
import { checkAiKey } from '~/utils/onboarding-flow'

// Option 3, "Your own OpenRouter key", shows only when the server says so
// (23-18 follow-up): app/plugins/ai-choice.server.ts copies the server-only
// NUXT_OPENROUTER_CHOICE_ENABLED into this page state. No state counts as off.
const openRouterShown = useState<boolean>('ln-openrouter-choice', () => false)

const choice = defineModel<AiChoice>({ default: 'default' })
/** The kind of key the server holds for this session after a good check, or null. */
const checkedKind = defineModel<OwnKeyKind | null>('checkedKind', { default: null })
const props = defineProps<{
  /** "Check your key before continuing." from the form's submit check or from checkout. */
  keyError?: string
}>()

const copy = AI_CHOICE_COPY
const items = computed(() => copy.options
  .filter(o => o.value !== 'openrouter' || openRouterShown.value === true)
  .map(o => ({ value: o.value, label: o.label, description: o.description })))

const key = ref('')
const billing = ref(false)
const checking = ref(false)
const replacing = ref(false)
const keyMessage = ref('')
const billingMessage = ref('')
const announce = ref('')
const keyInput = ref<{ inputRef?: HTMLInputElement | null } | null>(null)

const ownKind = computed<OwnKeyKind | null>(() => choice.value === 'default' ? null : choice.value)
const notes = computed(() => aiChoiceNotes(choice.value))
const checkedHere = computed(() => ownKind.value !== null && checkedKind.value === ownKind.value && !replacing.value)
const keyFieldError = computed(() => keyMessage.value || props.keyError || undefined)

watch(choice, () => {
  keyMessage.value = ''
  billingMessage.value = ''
  replacing.value = false
  key.value = ''
})

async function say(text: string) {
  announce.value = ''
  await nextTick()
  announce.value = text
}

function replace() {
  replacing.value = true
  key.value = ''
  nextTick(() => keyInput.value?.inputRef?.focus())
}

async function check() {
  const kind = ownKind.value
  if (!kind || checking.value) return
  keyMessage.value = ''
  billingMessage.value = ''
  if (!key.value.trim()) {
    keyMessage.value = KEY_FAILED_MESSAGE
    focusProblem('key')
    return
  }
  if (kind === 'gemini' && !billing.value) {
    billingMessage.value = GEMINI_BILLING_MESSAGE
    focusProblem('billing')
    return
  }
  checking.value = true
  const result = await checkAiKey(
    (url, opts) => $fetch(url, opts as Parameters<typeof $fetch>[1]) as Promise<unknown>,
    kind,
    key.value,
    kind === 'gemini' ? billing.value : false
  )
  checking.value = false
  if (result.kind === 'checked') {
    key.value = ''
    replacing.value = false
    checkedKind.value = kind
    await say(copy.keyChecked + '.')
    // "Check key" is gone now; focus goes to "Replace key" rather than the page.
    await nextTick()
    document.getElementById('ai-replace-key')?.focus()
    return
  }
  if (!result.kept) checkedKind.value = null
  if (result.field === 'billing') billingMessage.value = result.message
  else keyMessage.value = result.message
  focusProblem(result.field)
}

/**
 * Moves focus to the field whose message just appeared: its description
 * carries the message, so a screen reader hears it (fresh3 23-29,
 * second-model review C3).
 */
function focusProblem(field: 'key' | 'billing') {
  nextTick(() => {
    if (field === 'billing') document.getElementById('ai-billing')?.focus()
    else keyInput.value?.inputRef?.focus()
  })
}
</script>

<template>
  <section aria-labelledby="ai-choice-legend" class="flex flex-col gap-4">
    <p role="status" aria-live="polite" class="sr-only">
      {{ announce }}
    </p>

    <!-- No form name here or on the checkbox: Reka would add a hidden input with no label (axe). -->
    <UFormField :help="copy.help">
      <URadioGroup
        v-model="choice"
        :items="items"
        value-key="value"
        :ui="{ legend: 'text-base font-semibold text-highlighted mb-1' }"
      >
        <template #legend>
          <span id="ai-choice-legend">{{ copy.legend }}</span>
        </template>
      </URadioGroup>
    </UFormField>

    <p v-for="note in notes" :key="note" class="text-sm text-muted">
      {{ note }}
    </p>

    <template v-if="ownKind">
      <div v-if="checkedHere" class="flex flex-wrap items-center gap-3">
        <UBadge color="success" variant="subtle" icon="i-lucide-circle-check" :label="copy.keyChecked" size="lg" />
        <UButton id="ai-replace-key" type="button" variant="link" :label="copy.replaceKey" class="px-0" @click="replace" />
      </div>
      <div v-else class="flex flex-col gap-4">
        <UFormField :label="copy.keyLabel[ownKind]" name="aiKey" :help="copy.keyHelp" :error="keyFieldError">
          <UInput
            ref="keyInput"
            v-model="key"
            type="password"
            autocomplete="off"
            spellcheck="false"
            class="w-full"
          />
        </UFormField>
        <UButton
          type="button"
          color="neutral"
          variant="outline"
          :label="checking ? copy.checkButtonWorking : copy.checkButton"
          :loading="checking"
          class="self-start"
          @click="check"
        />
        <UFormField v-if="ownKind === 'gemini'" :error="billingMessage || undefined">
          <UCheckbox id="ai-billing" v-model="billing" :label="copy.geminiCheckbox" required />
        </UFormField>
      </div>
    </template>
  </section>
</template>
