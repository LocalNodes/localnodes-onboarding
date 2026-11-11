<script setup lang="ts">
// Who it's for (fresh3 LANDING.md 3.3, approved by Tom 2026-11-06). The buyer
// words (co-ops, guilds and DAOs, land trusts) are allowed here and in the
// example groups only (D-14); never in the sign-up flow (D-05). Pre-launch
// (Tom, 2026-11-06, PR #9): present tense, the finished product, no chips.
// The four cards and their order are Tom's positioning ruling of 2026-11-09;
// the Guilds and DAOs text is the orchestrator's correction of 2026-11-11
// (connecting an existing DAO is parked, so the card does not promise it).
// tests/unit/homepage-copy.test.ts holds the wording.
const groups = [
  {
    title: 'Neighborhoods and civic groups',
    icon: 'i-lucide-house',
    body: 'Neighborhood associations, tenant groups and civic clubs keep their minutes and decisions where anyone can ask "what did we decide about the garden?", run a mutual aid fund, and vote together.'
  },
  {
    title: 'Pop-up villages and gatherings',
    icon: 'i-lucide-tent',
    body: 'Pop-up villages, residencies and conferences keep their talks, notes and decisions, a shared fund for projects, and a way to decide, during the gathering and after everyone goes home.'
  },
  {
    title: 'Co-ops and land trusts',
    icon: 'i-lucide-trees',
    body: 'Housing, food and worker co-ops, land trusts and watershed groups keep bylaws, minutes, deeds and plans in one searchable place, and run shared money and votes there too.'
  },
  {
    title: 'Guilds and DAOs',
    icon: 'i-lucide-users',
    body: 'Online guilds and DAOs that already make decisions together: a library for your proposals, docs and history, with a shared fund and votes alongside.'
  }
]
</script>

<template>
  <section class="bg-muted">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 sm:py-20 flex flex-col gap-6">
      <h2 class="text-[28px] leading-tight font-semibold text-highlighted">
        Who it's for
      </h2>
      <p class="text-base text-muted">
        Groups that hold something in common and run it together.
      </p>
      <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <div
          v-for="group in groups"
          :key="group.title"
          class="bg-default rounded-lg border border-default p-6 flex flex-col gap-2.5"
        >
          <UIcon :name="group.icon" class="size-6 text-primary" aria-hidden="true" />
          <h3 class="text-xl font-semibold text-highlighted">
            {{ group.title }}
          </h3>
          <p class="leading-relaxed text-muted">
            {{ group.body }}
          </p>
        </div>
      </div>
      <p class="text-muted">
        Any group that shares a purpose is welcome, online or in one place.
      </p>
    </div>
  </section>
</template>
