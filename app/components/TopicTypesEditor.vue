<script setup lang="ts">
// Page types on the sign-up form (fresh3 23-19; D-20, approved in 23-UI-SPEC.md
// section 3 and its "Editable list" component). The organizer describes the
// community, asks for suggestions (POST /api/suggest-topic-types, 23-30), then
// edits, removes and adds rows. Nothing blocks checkout: a fallback or a rate
// limit leaves the add row, and skipping keeps the standard types.
//
// The fields carry no fixed field ids, so each keeps the id its UFormField
// gives it and its label matches in the server HTML (fresh3 23-39, F2b; as
// /invite since 14b24da). Focus moves find a row or the new-type field by the
// name its UFormField gives the input, inside this section.
import { computed, nextTick, ref } from 'vue'
import {
  MAX_PAGE_TYPES,
  SIGNUP_COPY,
  addTopicType,
  mergeSuggestions,
  removeLabel,
  removeTopicType,
  removedAnnouncement,
  rowLabel,
  suggestTopicTypes,
  suggestedAnnouncement
} from '~/utils/onboarding-flow'

const types = defineModel<string[]>({ default: () => [] })
const description = defineModel<string>('description', { default: '' })
const props = defineProps<{
  /** A message for the description from the form's submit check. */
  descriptionError?: string
}>()

const copy = SIGNUP_COPY.pageTypes
const suggesting = ref(false)
const notice = ref<'fallback' | 'too-many' | null>(null)
const suggestError = ref('')
const newType = ref('')
const announce = ref('')

const atMax = computed(() => types.value.length >= MAX_PAGE_TYPES)
const descriptionMessage = computed(() => props.descriptionError || suggestError.value || undefined)

/** Sets the polite message; clearing first makes a repeated sentence read out again. */
async function say(text: string) {
  announce.value = ''
  await nextTick()
  announce.value = text
}

const section = ref<HTMLElement | null>(null)

/** Focuses the input whose UFormField name is `name`, inside this section. */
function focusField(name: string) {
  section.value?.querySelector<HTMLElement>(`[name="${CSS.escape(name)}"]`)?.focus()
}

async function suggest() {
  if (suggesting.value) return
  suggesting.value = true
  notice.value = null
  suggestError.value = ''
  await say(copy.suggestingAnnouncement)
  const result = await suggestTopicTypes(
    (url, opts) => $fetch(url, opts as Parameters<typeof $fetch>[1]) as Promise<unknown>,
    description.value
  )
  suggesting.value = false
  if (result.kind === 'suggested') {
    const merged = mergeSuggestions(types.value, result.types)
    types.value = merged.list
    await say(suggestedAnnouncement(merged.added))
    await nextTick()
    focusField('topicTypes.0')
  } else if (result.kind === 'invalid') {
    suggestError.value = result.message
  } else {
    notice.value = result.kind
  }
}

function addType() {
  const next = addTopicType(types.value, newType.value)
  if (next.length === types.value.length) return
  types.value = next
  newType.value = ''
}

async function removeType(index: number) {
  const removed = types.value[index] ?? ''
  types.value = removeTopicType(types.value, index)
  await say(removedAnnouncement(removed))
  await nextTick()
  focusField(index > 0 ? `topicTypes.${index - 1}` : types.value.length ? 'topicTypes.0' : 'newType')
}

function updateRow(index: number, value: string) {
  const next = [...types.value]
  next[index] = value
  types.value = next
}
</script>

<template>
  <section ref="section" aria-labelledby="page-types-heading" class="flex flex-col gap-4">
    <h2 id="page-types-heading" class="text-xl font-semibold text-highlighted">
      {{ copy.heading }}
    </h2>
    <p class="text-base text-muted">
      {{ copy.intro }}
    </p>

    <p role="status" aria-live="polite" class="sr-only">
      {{ announce }}
    </p>

    <UFormField
      :label="copy.descriptionLabel"
      name="description"
      :help="copy.descriptionHelp"
      :error="descriptionMessage"
    >
      <UTextarea
        v-model="description"
        :rows="3"
        autoresize
        class="w-full"
      />
    </UFormField>

    <UButton
      type="button"
      color="neutral"
      variant="outline"
      :label="suggesting ? copy.suggesting : copy.suggest"
      :loading="suggesting"
      class="self-start"
      @click="suggest"
    />

    <UAlert
      v-if="notice === 'fallback'"
      role="status"
      color="neutral"
      variant="outline"
      icon="i-lucide-info"
      :description="copy.fallback"
      class="border-l-4 border-l-accented bg-default"
    />
    <UAlert
      v-if="notice === 'too-many'"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :description="copy.tooMany"
    />

    <div :aria-busy="suggesting ? 'true' : 'false'" class="flex flex-col gap-3">
      <UFormField
        v-for="(type, index) in types"
        :key="`row-${index}`"
        :label="rowLabel(index)"
        :name="`topicTypes.${index}`"
      >
        <div class="flex items-center gap-2">
          <UInput
            :model-value="type"
            maxlength="40"
            class="w-full"
            @update:model-value="updateRow(index, String($event))"
          />
          <UButton
            type="button"
            color="neutral"
            variant="ghost"
            icon="i-lucide-x"
            :aria-label="removeLabel(type)"
            class="min-h-11 min-w-11 justify-center"
            @click="removeType(index)"
          />
        </div>
      </UFormField>

      <UFormField v-if="!atMax" :label="copy.newLabel" name="newType">
        <div class="flex items-center gap-2">
          <UInput
            v-model="newType"
            maxlength="40"
            class="w-full"
            @keydown.enter.prevent="addType"
          />
          <UButton
            type="button"
            color="neutral"
            variant="outline"
            :label="copy.add"
            @click="addType"
          />
        </div>
      </UFormField>
      <p v-else class="text-sm text-muted">
        {{ copy.atMax }}
      </p>
    </div>

    <p class="text-sm text-muted">
      {{ copy.alwaysIncluded }}
    </p>
  </section>
</template>
