<script setup lang="ts">
// "Coming" chip: the highlight with dark text, in any context (BRAND.md
// section 5: the highlight only ever carries dark text). The `light` class
// pins the text role to the light one, so the chip reads the same on the
// light page and on the dark bands.
withDefaults(defineProps<{ label?: string }>(), { label: 'Coming' })
</script>

<template>
  <span class="light self-start inline-flex items-center bg-(--ui-secondary) text-highlighted rounded-full px-3 py-1 text-sm font-semibold whitespace-nowrap">
    {{ label }}
  </span>
</template>
