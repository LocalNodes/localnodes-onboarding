<script setup lang="ts">
// Open source (fresh3 LANDING.md 3.8, D-16, Tom 2026-11-05): both licences,
// never a GPL-only line. Community software: os-knowledge-garden's
// composer.json "GPL-2.0+"; sign-up app: this repo's LICENSE (PR #7).
const repos = [
  { label: 'Community software on GitHub', url: 'https://github.com/LocalNodes/os-knowledge-garden' },
  { label: 'Sign-up app on GitHub', url: 'https://github.com/LocalNodes/localnodes-onboarding' }
]
</script>

<template>
  <section class="bg-muted">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 sm:py-20 flex flex-col gap-4">
      <h2 class="text-[28px] leading-tight font-semibold text-highlighted">
        Open source
      </h2>
      <p class="text-base leading-relaxed text-muted max-w-xl">
        LocalNodes is open source (GPL and AGPL). The community software is
        GPL-2.0-or-later and the sign-up app is AGPL-3.0-or-later. Read the code,
        run it yourself, or let us host it for you.
      </p>
      <div class="flex flex-wrap gap-x-6 gap-y-2">
        <a
          v-for="repo in repos"
          :key="repo.url"
          :href="repo.url"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex items-center gap-1 text-primary underline"
        >
          {{ repo.label }}
          <UIcon name="i-lucide-external-link" class="size-4" aria-hidden="true" />
          <span class="sr-only">(opens in a new tab)</span>
        </a>
      </div>
      <p class="text-sm text-muted">
        Built on Open Social and Drupal, Nuxt, and Google's Gemini for the AI assistant.
      </p>
    </div>
  </section>
</template>
