<script setup lang="ts">
// The skip link (fresh3 23-39, C2; orchestrator rule C, 2026-11-08; 23-UI-SPEC
// "Skip link"). It is the first Tab stop on every sign-up page, hidden until it
// has focus, and moves focus to main.
//
// The click handler focuses main itself instead of letting the browser jump to
// the fragment: /invite/verify carries its sign-in token in the address
// fragment, and a fragment jump would replace it (a reload would then show the
// expired message). Enter on a link fires click, so the keyboard takes the same
// path. With scripts off, the href still jumps to main.
//
// The focused link sits above the sticky header (Nuxt UI's header theme is
// z-50). Its text is the highlighted colour, not primary: primary on white is
// under 4.5:1 for text (23-29 F1).
import { ref } from 'vue'

const mainContent = ref<HTMLElement | null>(null)

function skipToMain(event: MouseEvent) {
  event.preventDefault()
  mainContent.value?.focus()
}
</script>

<template>
  <div class="min-h-screen flex flex-col">
    <a
      href="#main-content"
      class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:px-4 focus:py-2 focus:rounded-md focus:bg-default focus:text-highlighted focus:underline focus:underline-offset-2 focus:outline-2 focus:outline-offset-2 focus:outline-primary"
      @click="skipToMain"
    >Skip to main content</a>
    <AppHeader />
    <main id="main-content" ref="mainContent" tabindex="-1" class="flex-1 focus:outline-none">
      <slot />
    </main>
    <AppFooter />
  </div>
</template>
