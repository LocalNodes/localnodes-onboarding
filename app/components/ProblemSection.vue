<script setup lang="ts">
// The problem (fresh3 LANDING.md 3.2, approved by Tom 2026-11-06). Borrowed
// from the earlier page's "Communities are getting a bad deal" framing (D-15),
// without its stats or its third-party fee figure. Pre-launch (Tom,
// 2026-11-06, PR #9): present tense, no chips.
const rows = [
  { usually: 'Documents scattered across apps nobody fully controls', could: 'One library your members can search and ask' },
  { usually: 'Answers from memory, or from whoever replies first', could: 'Answers that point to the page they came from' },
  { usually: 'One person holds the money and the passwords', could: 'A group fund that several members must approve' },
  { usually: 'Decisions made by whoever shows up', could: 'Decisions your members make by vote, with a public record' },
  { usually: 'Your community lives on someone else\'s platform', could: 'Open source software on your community\'s own site' }
]
</script>

<template>
  <section class="bg-default">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 sm:py-20 flex flex-col gap-6">
      <h2 class="text-3xl font-semibold text-highlighted">
        Communities are getting a bad deal
      </h2>
      <p class="text-lg leading-relaxed text-muted max-w-3xl">
        Your group's knowledge is spread across chat threads, shared drives and
        someone's inbox. The money sits in one person's account. And the tools you
        rely on belong to someone else, who can change the rules whenever they like.
      </p>

      <div class="grid gap-4 md:grid-cols-2">
        <div class="rounded-lg border border-default p-5 flex flex-col gap-3">
          <h3 class="text-lg font-semibold text-muted">
            How it usually works
          </h3>
          <ul class="flex flex-col gap-3">
            <li v-for="row in rows" :key="row.usually" class="flex gap-2">
              <UIcon name="i-lucide-x" class="size-5 shrink-0 mt-0.5 text-muted" aria-hidden="true" />
              <span>{{ row.usually }}</span>
            </li>
          </ul>
        </div>

        <div class="rounded-lg border-2 border-primary p-5 flex flex-col gap-3">
          <h3 class="text-lg font-semibold text-highlighted">
            How it could work
          </h3>
          <ul class="flex flex-col gap-3">
            <li v-for="row in rows" :key="row.could" class="flex gap-2">
              <UIcon name="i-lucide-check" class="size-5 shrink-0 mt-0.5 text-primary" aria-hidden="true" />
              <span>{{ row.could }}</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </section>
</template>
