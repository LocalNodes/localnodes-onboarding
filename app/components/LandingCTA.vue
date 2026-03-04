<template>
  <UPageSection
    id="get-started"
  >
    <div class="relative overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/80 p-8 sm:p-12 lg:p-16 text-center">
      <!-- Background gradient accent -->
      <div
        class="absolute inset-0 opacity-10"
        style="background: radial-gradient(ellipse at center, rgb(20 184 166) 0%, transparent 70%)"
      />

      <div class="relative">
        <h2 class="text-3xl sm:text-4xl font-bold text-zinc-100 mb-4">
          Your community's knowledge deserves a home
        </h2>
        <p class="text-lg text-zinc-400 max-w-2xl mx-auto mb-8">
          Stop losing conversations to chat apps and scattered documents.
          Give your community an AI-powered knowledge garden where everything grows together.
        </p>
        <div class="flex flex-col sm:flex-row gap-4 justify-center">
          <UButton
            label="Get Started"
            to="/onboarding"
            color="primary"
            size="xl"
          />
          <UButton
            label="See a Live Garden"
            to="https://cascadia.localnodes.xyz"
            target="_blank"
            variant="outline"
            size="xl"
          />
        </div>
      </div>
    </div>
  </UPageSection>
</template>
