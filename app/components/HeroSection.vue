<script setup lang="ts">
// Hero (fresh3 LANDING.md 3.1, approved by Tom 2026-11-06). The first dark
// band: the `dark` class scopes var(--ui-*) to the dark roles, so the band
// takes its colours from the token output rather than literals.
// TODO(22.1-08): the exact band colour (palette B brand 950) and its roles
// (muted text, answer card, source chip; BRAND.md section 5 "Dark mode") arrive
// through the Nuxt dark tokens in 22.1-08; nothing here hard-codes them.
</script>

<template>
  <section class="dark bg-default text-default">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-12 pb-16 sm:pt-16 sm:pb-20 grid gap-12 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] items-center">
      <div class="flex flex-col gap-6 min-w-0">
        <span class="self-start rounded-full border border-accented px-3.5 py-1.5 text-sm text-muted">
          Home base for communities that run things together.
        </span>

        <h1 class="text-4xl sm:text-5xl leading-[1.15] font-semibold text-highlighted text-balance">
          LocalNodes: your community's library, treasury and decisions, run by its members.
        </h1>

        <p class="text-lg leading-relaxed text-muted max-w-2xl">
          Start with the library: a home for your group's documents that members can
          search and ask, with every answer pointing to the page it came from. The
          treasury and shared decisions come next, each one tested before it ships.
        </p>

        <div class="flex flex-wrap gap-3">
          <UButton
            label="Set up your community's site"
            to="/onboarding"
            size="xl"
            color="primary"
          />
          <UButton
            label="Explore a demo community"
            to="#see-it-in-action"
            size="xl"
            color="neutral"
            variant="outline"
          />
        </div>
      </div>

      <HeroSearchDemo class="min-w-0" />
    </div>
  </section>
</template>
