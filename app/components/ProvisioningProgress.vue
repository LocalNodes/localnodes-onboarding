<script setup lang="ts">
defineProps<{
  stages: Array<{ id: string; label: string; state: 'completed' | 'active' | 'pending' }>
}>()
</script>

<template>
  <!-- fresh3 22-UI-SPEC Part 7 (onboarding): completed steps keep normal text
       plus a check icon, no strikethrough; no hard-coded white text, so the
       list reads on the forced-light /success page. -->
  <ol class="space-y-3">
    <li
      v-for="(stage, i) in stages"
      :key="stage.id"
      class="flex items-center gap-3"
      v-motion
      :initial="{ opacity: 0, x: -10 }"
      :enter="{ opacity: 1, x: 0, transition: { duration: 400, delay: i * 100 } }"
    >
      <!-- State indicator -->
      <div class="flex-none w-6 h-6 flex items-center justify-center">
        <UIcon
          v-if="stage.state === 'completed'"
          name="i-lucide-check-circle"
          class="text-primary w-6 h-6"
          aria-hidden="true"
        />
        <div
          v-else-if="stage.state === 'active'"
          class="w-5 h-5 rounded-full border-2 border-primary border-t-transparent animate-spin"
          aria-hidden="true"
        />
        <div
          v-else
          class="w-5 h-5 rounded-full border-2 border-(--ui-border-accented)"
          aria-hidden="true"
        />
      </div>
      <!-- Label -->
      <span
        :class="[
          'text-sm',
          stage.state === 'completed' ? 'text-(--ui-text)' : '',
          stage.state === 'active' ? 'text-(--ui-text) font-semibold' : '',
          stage.state === 'pending' ? 'text-(--ui-text-muted)' : ''
        ]"
      >{{ stage.label }}</span>
    </li>
  </ol>
</template>
