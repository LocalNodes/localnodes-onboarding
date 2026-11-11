<script setup lang="ts">
// The /unsubscribe page's states (fresh3 23-19 follow-up; 23-UI-SPEC.md
// "Unsubscribe page"). The page owns the token and the one POST; this shows
// the words for the phase it is given.
//
// - ready: the intro and the Unsubscribe button.
// - working: the button reads "Unsubscribing…" and is disabled; the one polite
//   live region says the same.
// - done: the done line, no button.
// - refused: the link-doesn't-work line in a danger alert, no button.
// - server-error: the line in a danger alert, and the button stays to try again.
// When a result appears, focus moves to its line (22-UI-SPEC Part 3 focus
// rules). The address is never shown.
//
// The two result lines take focus and carry no alert role: the focus move
// alone reads them, once (fresh3 23-39, F8 extended by the orchestrator's Q1
// answer, 2026-11-08; 23-UI-SPEC "Unsubscribe page").
import { nextTick, onMounted, ref, watch } from 'vue'
import { UNSUBSCRIBE_COPY, type UnsubscribePhase } from '~/utils/unsubscribe-flow'

const props = defineProps<{ phase: UnsubscribePhase }>()
const emit = defineEmits<{ confirm: [] }>()

const copy = UNSUBSCRIBE_COPY
const result = ref<HTMLElement | null>(null)

const isResult = (phase: UnsubscribePhase) => phase === 'done' || phase === 'refused' || phase === 'server-error'

async function focusResult() {
  await nextTick()
  result.value?.focus()
}
// A link with no usable token opens on the refused line.
onMounted(() => {
  if (isResult(props.phase)) focusResult()
})
watch(() => props.phase, (now) => {
  if (isResult(now)) focusResult()
})
</script>

<template>
  <div>
    <!-- Always present, so the change is announced. -->
    <p aria-live="polite" class="sr-only">{{ phase === 'working' ? copy.buttonWorking : '' }}</p>

    <p
      v-if="phase === 'done'"
      ref="result"
      tabindex="-1"
      class="text-base text-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >{{ copy.done }}</p>

    <div
      v-else-if="phase === 'refused'"
      ref="result"
      tabindex="-1"
      class="mt-6 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      <UAlert
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :description="copy.refused"
      />
    </div>

    <div v-else class="flex flex-col gap-6">
      <p class="text-base text-muted mb-2">
        {{ copy.intro }}
      </p>
      <div
        v-if="phase === 'server-error'"
        ref="result"
        tabindex="-1"
        class="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <UAlert
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :description="copy.serverError"
        />
      </div>
      <UButton
        type="button"
        :label="phase === 'working' ? copy.buttonWorking : copy.button"
        :loading="phase === 'working'"
        :disabled="phase === 'working'"
        size="xl"
        color="primary"
        class="self-start"
        @click="emit('confirm')"
      />
    </div>
  </div>
</template>
