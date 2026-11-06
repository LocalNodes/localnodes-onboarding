<script setup lang="ts">
// What you get today (fresh3 LANDING.md 3.4, approved by Tom 2026-11-06).
// Each item matches a claims-inventory row (LANDING.md section 5).
// Status per LANDING.md section 5 (Codex review, 2026-11-06): the cited
// assistant, the site, hybrid search and hosting work today on the demos
// (cascadia, boulder; checked 2026-11-06). Bulk import and permission-aware
// answers are Phase 22, built but not deployed yet, so they carry
// a "Coming" badge until Phase 22 is deployed and verified on the demos
// (22-26 and 22-27 pass on a demo).
const features: { title: string, icon: string, body: string, coming?: boolean }[] = [
  {
    title: 'Ask your library a question.',
    icon: 'i-lucide-message-circle',
    body: 'Ask the AI assistant and it answers from your group\'s pages, with numbered sources that link to each one.'
  },
  {
    title: 'Bring in many files at once.',
    icon: 'i-lucide-file-text',
    body: 'Upload a batch of your group\'s documents or import web pages, and each becomes a page members can search and ask about.',
    coming: true
  },
  {
    title: 'Answers that respect who can see what.',
    icon: 'i-lucide-lock',
    body: 'A member\'s answers draw only on pages that member is allowed to see. Private group pages stay private.',
    coming: true
  },
  {
    title: 'Your community\'s own site.',
    icon: 'i-lucide-globe',
    body: 'Groups, events, topics and member profiles, on your own address: yourname.localnodes.xyz.'
  },
  {
    title: 'Search that finds what you mean.',
    icon: 'i-lucide-search',
    body: 'Keyword search and meaning-based search work together.'
  },
  {
    title: 'Hosting and updates handled.',
    icon: 'i-lucide-server',
    body: 'We run the site and keep it updated, so you can get on with your community.'
  }
]
</script>

<template>
  <section class="bg-default">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 sm:py-20 flex flex-col gap-6">
      <h2 class="text-3xl font-semibold text-highlighted">
        What you get today
      </h2>
      <p class="text-lg font-semibold text-highlighted">
        Every answer shows the page it came from.
      </p>
      <p class="text-lg text-muted">
        Everything here works today unless it's marked Coming. You can try it on a
        demo site.
      </p>
      <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <div
          v-for="feature in features"
          :key="feature.title"
          class="rounded-lg border border-default p-5 flex flex-col gap-2"
        >
          <UIcon :name="feature.icon" class="size-6 text-primary" aria-hidden="true" />
          <h3 class="text-lg font-semibold text-highlighted">
            {{ feature.title }}
          </h3>
          <p class="leading-relaxed text-muted">
            {{ feature.body }}
          </p>
          <ComingChip v-if="feature.coming" />
        </div>
      </div>
    </div>
  </section>
</template>
