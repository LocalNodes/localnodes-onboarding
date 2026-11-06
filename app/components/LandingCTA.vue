<script setup lang="ts">
// Call to action (fresh3 LANDING.md 3.9, approved by Tom 2026-11-06).
</script>

<template>
  <section class="bg-default">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20 flex flex-col items-center gap-5 text-center">
      <h2 class="text-3xl sm:text-4xl font-semibold text-highlighted text-balance">
        Give your community a home base
      </h2>
      <p class="text-lg text-muted">
        Start with the library today. The rest arrives one tested step at a time.
      </p>
      <div class="flex flex-wrap justify-center gap-3">
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
          color="primary"
          variant="link"
        />
      </div>
    </div>
  </section>
</template>
