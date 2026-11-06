<script setup lang="ts">
// The hero's typing search box (fresh3 LANDING.md 3.1, Tom 2026-11-06, card 8).
// A picture of the library, not a live search: it accepts no input. Screen
// readers get question 1 and answer 1 as plain text; the animation is
// aria-hidden. Under prefers-reduced-motion: reduce it shows question 1, still,
// and it follows changes to that setting while the page is open.
// Chips: questions 1-3 cite a demo page; 4 to 6 say "Coming", no rung
// (D-16 as revised, Tom 2026-11-06).

import { useHeroDemo, type DemoQA } from '~/composables/useHeroDemo'

const items: DemoQA[] = [
  { q: 'What did we decide about the roof repair?', a: 'Members agreed to get three quotes before the spring meeting.', chip: '[1] Meeting notes, 12 March', coming: false },
  { q: 'How does a new member join?', a: 'An organizer invites them, and they confirm by email.', chip: '[1] Membership policy', coming: false },
  { q: 'Where do our bylaws say how votes work?', a: 'Section 4: a vote passes with a majority of members present.', chip: '[1] Bylaws', coming: false },
  { q: 'Draft a proposal to buy shared garden tools.', a: 'The assistant will draft it for you to check and submit.', chip: 'Coming', coming: true },
  { q: 'Which projects in our network need funding right now?', a: 'Groups will be able to show what they need and fund each other.', chip: 'Coming', coming: true },
  { q: 'How did another community structure its governance?', a: 'You\'ll be able to ask other communities\' public pages, with their name on every source.', chip: 'Coming', coming: true }
]

const first = items[0]!
// Reduced motion is followed live (on: question 1, still, no pause button;
// off: the cycle resumes); see useHeroDemo.
const { typed, showAnswer, animating, paused, current, togglePause, mount, unmount } = useHeroDemo(items)

onMounted(mount)
onBeforeUnmount(unmount)
</script>

<template>
  <div class="flex flex-col gap-3">
    <p class="text-sm font-semibold text-muted">
      Example answers from a demo library
    </p>

    <!-- Screen readers: question 1 and answer 1 as plain text. -->
    <p class="sr-only">
      Example question: {{ first.q }} Example answer: {{ first.a }} Source: {{ first.chip }}.
    </p>

    <div aria-hidden="true" class="flex flex-col gap-3">
      <!-- The white search field: a light context inside the dark band. -->
      <div class="light bg-default text-default rounded-lg min-h-13 px-4 flex items-center gap-2.5 outline-2 outline-offset-2 outline-(--ui-secondary)">
        <UIcon name="i-lucide-search" class="size-5 shrink-0 text-muted" />
        <span class="min-w-0">{{ typed }}</span>
        <span
          v-if="animating && !showAnswer"
          class="w-0.5 h-5 bg-(--ui-text) shrink-0"
        />
      </div>

      <div
        class="bg-elevated rounded-lg p-4 flex flex-col gap-3 transition-opacity duration-150 ease-out"
        :class="showAnswer ? 'opacity-100' : 'opacity-0'"
      >
        <p class="text-highlighted leading-normal">
          {{ current.a }}
        </p>
        <ComingChip v-if="current.coming" :label="current.chip" />
        <span
          v-else
          class="self-start bg-inverted text-inverted rounded-full px-3 py-1 text-sm font-semibold"
        >{{ current.chip }}</span>
      </div>
    </div>

    <div v-if="animating" class="flex">
      <UButton
        :label="paused ? 'Play examples' : 'Pause examples'"
        :icon="paused ? 'i-lucide-play' : 'i-lucide-pause'"
        variant="ghost"
        color="neutral"
        size="sm"
        @click="togglePause"
      />
    </div>
  </div>
</template>
