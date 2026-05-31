<script setup lang="ts">
defineProps<{
  stages: Array<{ id: string; label: string; state: 'completed' | 'active' | 'pending' }>
}>()
</script>

<template>
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
          class="text-primary-500 w-6 h-6"
        />
        <div
          v-else-if="stage.state === 'active'"
          class="w-5 h-5 rounded-full border-2 border-primary-500 border-t-transparent animate-spin"
        />
        <div
          v-else
          class="w-5 h-5 rounded-full border-2 border-(--ui-border)"
        />
      </div>
      <!-- Label -->
      <span
        :class="[
          'text-sm',
          stage.state === 'completed' ? 'text-primary-400 line-through' : '',
          stage.state === 'active' ? 'text-white font-medium' : '',
          stage.state === 'pending' ? 'text-(--ui-text-muted)' : ''
        ]"
      >{{ stage.label }}</span>
    </li>
  </ol>
</template>
