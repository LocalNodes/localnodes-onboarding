<template>
  <!-- Colours come from the semantic palette vars (D-03), so the 22.1-08
       palette swap recolours it. Reduced motion: main.css flattens the loops. -->
  <!-- Outer wrapper with v-motion for initial mount animation. Decorative:
       hidden from assistive technology (23-UI-SPEC section 4). -->
  <div
    aria-hidden="true"
    class="relative w-48 h-48 mx-auto"
    v-motion
    :initial="{ opacity: 0, scale: 0.8 }"
    :enter="{ opacity: 1, scale: 1, transition: { duration: 800, type: 'spring', stiffness: 60 } }"
  >
    <!-- Ambient glow: slow-pulsing primary radial gradient -->
    <div
      class="absolute inset-0 rounded-full opacity-30 blur-[40px] animate-[pulse_4s_ease-in-out_infinite]"
      style="background: radial-gradient(circle, var(--ui-color-primary-500) 0%, transparent 70%)"
    />
    <!-- SVG botanical scene -->
    <svg class="absolute inset-0 w-full h-full" viewBox="0 0 192 192" fill="none" xmlns="http://www.w3.org/2000/svg">
      <!-- Ground circle -->
      <circle cx="96" cy="96" r="72" stroke-width="1" opacity="0.2"
        style="stroke: var(--ui-color-primary-500)" />
      <!-- Center stem -->
      <line x1="96" y1="140" x2="96" y2="60" stroke-width="2" opacity="0.6"
        style="stroke: var(--ui-color-primary-500)" />
      <!-- Leaf left -->
      <path
        d="M96 90 Q70 80 64 60 Q86 68 96 90Z"
        opacity="0.4"
        class="animate-[pulse_3s_ease-in-out_infinite]"
        style="fill: var(--ui-color-primary-500)"
      />
      <!-- Leaf right -->
      <path
        d="M96 90 Q122 80 128 60 Q106 68 96 90Z"
        opacity="0.4"
        class="animate-[pulse_3s_ease-in-out_infinite]"
        style="fill: var(--ui-color-primary-400); animation-delay: 0.5s"
      />
      <!-- Center bloom -->
      <circle
        cx="96" cy="56" r="10"
        opacity="0.6"
        class="animate-[pulse_2s_ease-in-out_infinite]"
        style="fill: var(--ui-color-primary-500)"
      />
      <circle cx="96" cy="56" r="5" opacity="0.8"
        style="fill: var(--ui-color-secondary-400)" />
      <!-- Floating particles -->
      <circle
        cx="60" cy="80" r="2"
        opacity="0.4"
        class="animate-[ping_2s_cubic-bezier(0,0,0.2,1)_infinite]"
        style="fill: var(--ui-color-primary-500)"
      />
      <circle
        cx="132" cy="96" r="1.5"
        opacity="0.4"
        class="animate-[ping_3s_cubic-bezier(0,0,0.2,1)_infinite]"
        style="fill: var(--ui-color-secondary-400); animation-delay: 0.8s"
      />
      <circle
        cx="80" cy="120" r="1.5"
        opacity="0.3"
        class="animate-[ping_2.5s_cubic-bezier(0,0,0.2,1)_infinite]"
        style="fill: var(--ui-color-primary-500); animation-delay: 1.2s"
      />
      <!-- Concentric growth rings -->
      <circle
        cx="96" cy="96" r="40"
        stroke-width="0.5"
        opacity="0.15"
        class="animate-[ping_4s_cubic-bezier(0,0,0.2,1)_infinite]"
        style="stroke: var(--ui-color-primary-500)"
      />
      <circle
        cx="96" cy="96" r="56"
        stroke-width="0.3"
        opacity="0.1"
        class="animate-[ping_5s_cubic-bezier(0,0,0.2,1)_infinite]"
        style="stroke: var(--ui-color-secondary-400); animation-delay: 1s"
      />
    </svg>
  </div>
</template>
