<script setup lang="ts">
// What you get (fresh3 LANDING.md 3.4, approved by Tom 2026-11-06). Pre-launch
// (Tom, 2026-11-06, PR #9): the finished product in the present tense, no
// chips; the trust point "Every answer shows the page it came from" leads, and
// "second brain" describes the library here, never as the headline. Sharing
// (posts, events, groups, conversations: Open Social underneath) gets its own
// item, since it's what members do every day.
const features: { title: string, icon: string, body: string }[] = [
  {
    title: 'Share what\'s happening.',
    icon: 'i-lucide-messages-square',
    body: 'Posts, events, groups and conversations in one activity stream your members follow.'
  },
  {
    title: 'Ask your library a question.',
    icon: 'i-lucide-message-circle',
    body: 'Ask the AI assistant and it answers from your group\'s pages, with numbered sources that link to each one.'
  },
  {
    title: 'Bring in many files at once.',
    icon: 'i-lucide-file-text',
    body: 'Upload a batch of your group\'s documents or import web pages, and each becomes a page members can search and ask about.'
  },
  {
    title: 'Answers that respect who can see what.',
    icon: 'i-lucide-lock',
    body: 'A member\'s answers draw only on pages that member is allowed to see. Private group pages stay private.'
  },
  {
    title: 'Your community\'s own site, hosted for you.',
    icon: 'i-lucide-globe',
    body: 'Groups, events, topics and member profiles on your own address, yourname.localnodes.xyz. We run it and keep it updated.'
  },
  {
    title: 'Search that finds what you mean.',
    icon: 'i-lucide-search',
    body: 'Keyword search and meaning-based search work together.'
  }
]
</script>

<template>
  <section class="bg-default">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 sm:py-20 flex flex-col gap-6">
      <h2 class="text-[28px] leading-tight font-semibold text-highlighted">
        What you get
      </h2>
      <p class="text-base text-muted max-w-xl">
        Your library is your community's second brain: every document, minute and
        decision in one place, ready for any member to ask.
      </p>
      <p class="text-base font-semibold text-highlighted">
        Every answer shows the page it came from.
      </p>
      <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <div
          v-for="feature in features"
          :key="feature.title"
          class="rounded-lg border border-default p-5 flex flex-col gap-2"
        >
          <UIcon :name="feature.icon" class="size-6 text-primary" aria-hidden="true" />
          <h3 class="text-xl font-semibold text-highlighted">
            {{ feature.title }}
          </h3>
          <p class="leading-relaxed text-muted">
            {{ feature.body }}
          </p>
        </div>
      </div>
    </div>
  </section>
</template>
