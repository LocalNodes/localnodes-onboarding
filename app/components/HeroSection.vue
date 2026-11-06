<script setup lang="ts">
// Hero (fresh3 LANDING.md 3.1). Pre-launch (Tom, 2026-11-06, PR #9):
// LocalNodes launches only when funds and votes are complete, so the page
// describes the finished product in the present tense and carries one honest
// pre-launch statement (`data-prelaunch`, read by the claims check). Headline
// chosen by Tom, 2026-11-06. The first dark band: the `dark` class scopes
// var(--ui-*) to the dark roles.
// TODO(22.1-08): the exact band colour (palette B brand 950) and its roles
// arrive through the Nuxt dark tokens in 22.1-08; nothing here hard-codes them.
</script>

<template>
  <section class="dark bg-default text-default">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-12 pb-16 sm:pt-16 sm:pb-20 grid gap-12 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] items-center">
      <div class="flex flex-col gap-6 min-w-0">
        <p data-prelaunch class="self-start inline-flex flex-wrap items-center gap-x-1.5 rounded-full border border-accented px-3.5 py-1.5 text-sm text-default">
          <span class="font-semibold text-highlighted">Launching soon.</span>
          <span>
            <ULink to="#see-it-in-action" class="text-primary underline underline-offset-2">See the demo</ULink>
            or
            <ULink to="#early-access" class="text-primary underline underline-offset-2">get early access</ULink>.
          </span>
        </p>

        <h1 class="text-4xl sm:text-5xl leading-[1.15] font-semibold text-highlighted text-balance">
          Where your community thinks, decides and funds together.
        </h1>

        <p class="text-lg leading-relaxed text-muted max-w-2xl">
          Share posts, events and conversations, keep a library every member can
          ask, run a group fund, and vote on what happens next.
        </p>

        <div class="flex flex-wrap gap-3">
          <UButton
            label="Get early access"
            to="#early-access"
            size="xl"
            color="primary"
          />
          <UButton
            label="See the demo"
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
