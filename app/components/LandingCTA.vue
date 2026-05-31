<template>
  <UPageSection
    id="get-started"
  >
    <div 
      v-motion
      :initial="{ opacity: 0, scale: 0.95, y: 20 }"
      :visibleOnce="{ opacity: 1, scale: 1, y: 0, transition: { duration: 800, type: 'spring', stiffness: 45 } }"
      class="relative overflow-hidden rounded-3xl border border-zinc-800/80 bg-zinc-900/60 p-10 sm:p-16 lg:p-20 text-center shadow-2xl backdrop-blur-xl group"
    >
      <!-- Background gradient accent -->
      <div
        class="absolute inset-0 opacity-20 group-hover:opacity-30 transition-opacity duration-700 blur-[100px] pointer-events-none mix-blend-screen"
        style="background: radial-gradient(ellipse at center, rgb(20 184 166) 0%, transparent 60%)"
      />
      
      <!-- Secondary amber accent -->
      <div
        class="absolute -top-24 -right-24 w-64 h-64 opacity-10 group-hover:opacity-20 transition-opacity duration-700 blur-[80px] pointer-events-none mix-blend-screen"
        style="background: radial-gradient(circle at center, rgb(245 158 11) 0%, transparent 70%)"
      />

      <div class="relative z-10">
        <h2 class="text-4xl sm:text-5xl font-bold text-zinc-100 mb-6 tracking-tight">
          Your community's knowledge deserves a <span class="text-transparent bg-clip-text bg-gradient-to-r from-primary-400 to-teal-200">home</span>
        </h2>
        <p class="text-xl text-zinc-400 max-w-2xl mx-auto mb-10 font-light leading-relaxed">
          Stop losing conversations to chat apps and scattered documents.
          Give your community an AI-powered knowledge garden where everything grows together.
        </p>
        <div class="flex flex-col sm:flex-row gap-5 justify-center mt-8">
          <UButton
            label="Get Started"
            to="/onboarding"
            color="primary"
            size="xl"
            class="shadow-lg shadow-primary/20 hover:shadow-primary/40 transition-shadow duration-300 font-medium px-8"
          />
          <UButton
            label="See a Live Garden"
            to="https://cascadia.localnodes.xyz"
            target="_blank"
            variant="outline"
            size="xl"
            class="hover:bg-zinc-800 transition-colors duration-300 font-medium px-8 backdrop-blur-md"
          />
        </div>
      </div>
    </div>
  </UPageSection>
</template>
