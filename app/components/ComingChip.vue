<script setup lang="ts">
// "Coming" chip: the highlight with dark text, in any context (BRAND.md
// section 5: the highlight only ever carries dark text). The `light` class
// pins the text role to the light one, so the chip reads the same on the
// light page and on the dark bands. One small badge per feature, always the
// word "Coming" and nothing more (D-16 as revised, Tom 2026-11-06); the
// claims check reads it through `data-badge`.
withDefaults(defineProps<{ label?: string }>(), { label: 'Coming' })
</script>

<template>
  <span data-badge class="light self-start inline-flex items-center bg-(--ui-secondary) text-highlighted rounded-full px-3 py-1 text-sm font-semibold whitespace-nowrap">
    {{ label }}
  </span>
</template>
