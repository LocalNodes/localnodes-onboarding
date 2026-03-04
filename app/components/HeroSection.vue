<template>
  <UPageHero
    orientation="horizontal"
    :links="[
      { label: 'Get Started', to: '/onboarding', size: 'xl', color: 'primary' },
      { label: 'See a Live Garden', to: 'https://cascadia.localnodes.xyz', target: '_blank', size: 'xl', variant: 'outline' }
    ]"
  >
    <template #headline>
      <UBadge variant="subtle" color="primary" size="lg">
        For Community Organizers
      </UBadge>
    </template>

    <template #title>
      Your community's knowledge is scattered across
      <span class="text-primary">dozens of tools</span>
    </template>

    <template #description>
      LocalNodes brings it all together in one AI-powered knowledge garden.
      A place where conversations, events, and shared wisdom grow -- and an
      AI assistant that actually understands your community.
    </template>

    <template #default>
      <!-- Abstract geometric art using CSS gradients -->
      <div class="relative w-full aspect-square max-w-lg mx-auto">
        <!-- Background glow -->
        <div class="absolute inset-0 rounded-3xl overflow-hidden">
          <!-- Primary teal gradient orb -->
          <div
            class="absolute top-1/4 left-1/4 w-3/4 h-3/4 rounded-full opacity-30 blur-3xl"
            style="background: radial-gradient(circle, rgb(20 184 166) 0%, transparent 70%)"
          />
          <!-- Secondary amber gradient orb -->
          <div
            class="absolute bottom-1/4 right-1/4 w-2/3 h-2/3 rounded-full opacity-25 blur-3xl"
            style="background: radial-gradient(circle, rgb(245 158 11) 0%, transparent 70%)"
          />
          <!-- Conic gradient overlay -->
          <div
            class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-4/5 h-4/5 rounded-full opacity-20 blur-2xl"
            style="background: conic-gradient(from 45deg, rgb(20 184 166), rgb(245 158 11), rgb(20 184 166))"
          />
        </div>

        <!-- Geometric shapes -->
        <svg class="absolute inset-0 w-full h-full" viewBox="0 0 400 400" fill="none" xmlns="http://www.w3.org/2000/svg">
          <!-- Interconnected nodes representing community knowledge -->
          <circle cx="200" cy="200" r="120" stroke="rgb(20 184 166)" stroke-width="1" opacity="0.3" />
          <circle cx="200" cy="200" r="80" stroke="rgb(20 184 166)" stroke-width="1" opacity="0.2" />
          <circle cx="200" cy="200" r="160" stroke="rgb(245 158 11)" stroke-width="0.5" opacity="0.15" />

          <!-- Knowledge nodes -->
          <circle cx="200" cy="80" r="8" fill="rgb(20 184 166)" opacity="0.6" />
          <circle cx="310" cy="150" r="6" fill="rgb(245 158 11)" opacity="0.5" />
          <circle cx="310" cy="260" r="7" fill="rgb(20 184 166)" opacity="0.4" />
          <circle cx="200" cy="320" r="8" fill="rgb(245 158 11)" opacity="0.6" />
          <circle cx="90" cy="260" r="6" fill="rgb(20 184 166)" opacity="0.5" />
          <circle cx="90" cy="150" r="7" fill="rgb(245 158 11)" opacity="0.4" />

          <!-- Connection lines -->
          <line x1="200" y1="80" x2="310" y2="150" stroke="rgb(20 184 166)" stroke-width="0.5" opacity="0.2" />
          <line x1="310" y1="150" x2="310" y2="260" stroke="rgb(245 158 11)" stroke-width="0.5" opacity="0.2" />
          <line x1="310" y1="260" x2="200" y2="320" stroke="rgb(20 184 166)" stroke-width="0.5" opacity="0.2" />
          <line x1="200" y1="320" x2="90" y2="260" stroke="rgb(245 158 11)" stroke-width="0.5" opacity="0.2" />
          <line x1="90" y1="260" x2="90" y2="150" stroke="rgb(20 184 166)" stroke-width="0.5" opacity="0.2" />
          <line x1="90" y1="150" x2="200" y2="80" stroke="rgb(245 158 11)" stroke-width="0.5" opacity="0.2" />

          <!-- Central knowledge garden symbol -->
          <circle cx="200" cy="200" r="24" fill="rgb(20 184 166)" opacity="0.15" />
          <circle cx="200" cy="200" r="12" fill="rgb(20 184 166)" opacity="0.3" />
          <circle cx="200" cy="200" r="4" fill="rgb(20 184 166)" opacity="0.8" />
        </svg>

        <!-- Floating accent dots -->
        <div class="absolute top-8 right-12 w-3 h-3 rounded-full bg-amber-400/40 animate-pulse" />
        <div class="absolute bottom-16 left-8 w-2 h-2 rounded-full bg-teal-400/50 animate-pulse" style="animation-delay: 1s" />
        <div class="absolute top-1/3 right-8 w-2 h-2 rounded-full bg-teal-400/30 animate-pulse" style="animation-delay: 2s" />
      </div>
    </template>
  </UPageHero>
</template>
