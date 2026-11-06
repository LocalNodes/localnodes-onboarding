<script setup lang="ts">
// The LocalNodes lock-up (fresh3 .planning/brand/logo/, Tom 2026-11-06):
// direction B's node mark plus the two-tone wordmark, "Nodes" in the brand
// colour. Colours come from semantic roles, not hex, so the 22.1-08 palette
// swap recolours it: on a light surface the mark is the primary; reversed
// (inside a dark band) the mark and "Local" are the highlighted text colour
// and "Nodes" is the dark-context primary. The centre dot is the highlight.
withDefaults(defineProps<{ reversed?: boolean, size?: 'sm' | 'md' }>(), {
  reversed: false,
  size: 'md'
})
</script>

<template>
  <span class="inline-flex items-center gap-2 font-semibold" :class="[reversed ? 'text-highlighted' : 'text-default', size === 'sm' ? 'text-base' : 'text-xl']">
    <svg
      viewBox="0 0 48 48"
      :class="[size === 'sm' ? 'size-6' : 'size-8', reversed ? 'text-highlighted' : 'text-primary']"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="24" cy="24" r="15" fill="none" stroke="currentColor" stroke-width="3" />
      <circle cx="24" cy="9" r="5" fill="currentColor" />
      <circle cx="11" cy="31.5" r="5" fill="currentColor" />
      <circle cx="37" cy="31.5" r="5" fill="currentColor" />
      <circle cx="24" cy="24" r="4.5" class="fill-(--ui-secondary)" />
    </svg>
    <span>Local<span class="text-primary">Nodes</span></span>
  </span>
</template>
