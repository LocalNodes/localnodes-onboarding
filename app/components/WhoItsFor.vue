<script setup lang="ts">
// Who it's for (fresh3 LANDING.md 3.3, approved by Tom 2026-11-06). The buyer
// words (co-ops, guilds and DAOs, land trusts) are allowed here and in the
// example groups only (D-14); never in the sign-up flow (D-05).
const groups = [
  {
    title: 'Co-ops',
    icon: 'i-lucide-house',
    body: 'Housing, food, energy or worker co-ops: keep your bylaws, minutes and policies in one place members can ask about, and run your shared money and votes the same way.'
  },
  {
    title: 'Guilds and DAOs',
    icon: 'i-lucide-users',
    body: 'Online guilds and DAOs that already make decisions together: a library for your proposals, docs and history, connected to the shared accounts and voting you already use, nothing redeployed.'
  },
  {
    title: 'Land trusts',
    icon: 'i-lucide-trees',
    body: 'Community land trusts and watershed groups: one home for deeds, plans, surveys and meeting notes, for the people who steward the land together.'
  }
]
</script>

<template>
  <section class="bg-muted">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 sm:py-20 flex flex-col gap-6">
      <h2 class="text-3xl font-semibold text-highlighted">
        Who it's for
      </h2>
      <p class="text-lg text-muted">
        Groups that hold something in common and run it together.
      </p>
      <div class="grid gap-4 md:grid-cols-3">
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
