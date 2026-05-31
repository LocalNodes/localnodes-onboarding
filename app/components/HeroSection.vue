<template>
  <UPageHero
    orientation="horizontal"
    :links="[
      { label: 'Get Started', to: '/onboarding', size: 'xl', color: 'primary' },
      { label: 'See a Live Garden', to: 'https://cascadia.localnodes.xyz', target: '_blank', size: 'xl', variant: 'outline' }
    ]"
  >
    <template #headline>
      <div
        v-motion
        :initial="{ opacity: 0, y: 20 }"
        :enter="{ opacity: 1, y: 0, transition: { duration: 800 } }"
      >
        <UBadge variant="subtle" color="primary" size="lg" class="shadow-sm ring-1 ring-primary/20 backdrop-blur-md">
          For Community Organizers
        </UBadge>
      </div>
    </template>

    <template #title>
      <!-- LCP element: kept fully opaque at first paint (subtle scale only) so
           it isn't hidden behind a fade-in during hydration. -->
      <div
        v-motion
        :initial="{ scale: 0.97 }"
        :enter="{ scale: 1, transition: { duration: 800, delay: 100 } }"
      >
        Your community's knowledge is scattered across
        <span class="text-transparent bg-clip-text bg-gradient-to-r from-primary-400 to-amber-400">dozens of tools</span>
      </div>
    </template>

    <template #description>
      <div
        v-motion
        :initial="{ opacity: 0, y: 20 }"
        :enter="{ opacity: 1, y: 0, transition: { duration: 1000, delay: 400 } }"
      >
        LocalNodes brings it all together in one AI-powered knowledge garden.
        A place where conversations, events, and shared wisdom grow -- and an
        <span class="font-medium text-white">AI assistant that actually understands your community.</span>
      </div>
    </template>

    <template #default>
      <!-- Abstract geometric art using CSS gradients -->
      <div 
        class="relative w-full aspect-square max-w-lg mx-auto"
        v-motion
        :initial="{ opacity: 0, scale: 0.9 }"
        :enter="{ opacity: 1, scale: 1, transition: { duration: 1200, delay: 600, type: 'spring', stiffness: 50 } }"
      >
        <!-- Background glow -->
        <div class="absolute inset-0 rounded-3xl overflow-hidden shadow-2xl shadow-primary/10">
          <!-- Primary teal gradient orb -->
          <div
            class="absolute top-1/4 left-1/4 w-3/4 h-3/4 rounded-full opacity-40 blur-[80px] mix-blend-screen animate-[pulse_6s_ease-in-out_infinite]"
            style="background: radial-gradient(circle, rgb(20 184 166) 0%, transparent 70%)"
          />
          <!-- Secondary amber gradient orb -->
          <div
            class="absolute bottom-1/4 right-1/4 w-2/3 h-2/3 rounded-full opacity-35 blur-[80px] mix-blend-screen animate-[pulse_8s_ease-in-out_infinite_reverse]"
            style="background: radial-gradient(circle, rgb(245 158 11) 0%, transparent 70%)"
          />
          <!-- Conic gradient overlay -->
          <div
            class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-4/5 h-4/5 rounded-full opacity-30 blur-3xl animate-[spin_20s_linear_infinite]"
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
