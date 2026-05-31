<template>
  <UPageSection
    id="features"
    headline="Three pillars"
    title="Everything your community needs"
    description="Three foundations, working together, to help your community thrive."
  >
    <!-- Three pillars with equal weight -->
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-8 mb-16">
      <div
        v-for="(pillar, index) in pillars"
        :key="pillar.title"
        v-motion
        :initial="{ opacity: 0, y: 50 }"
        :visibleOnce="{ opacity: 1, y: 0, transition: { duration: 800, delay: index * 200, type: 'spring', stiffness: 40 } }"
        class="relative p-8 rounded-3xl border border-zinc-800/60 bg-zinc-900/40 backdrop-blur-xl hover:border-primary/50 hover:bg-zinc-800/40 hover:-translate-y-2 transition-all duration-500 group overflow-hidden shadow-lg hover:shadow-primary/20"
      >
        <!-- subtle gradient background on hover -->
        <div class="absolute inset-0 bg-gradient-to-br from-primary/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 rounded-3xl pointer-events-none" />
        
        <div class="relative z-10">
          <div class="flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 mb-8 border border-primary/20 group-hover:scale-110 group-hover:bg-primary/20 transition-all duration-300 shadow-inner">
            <UIcon :name="pillar.icon" class="text-4xl text-primary/80 group-hover:text-primary transition-colors duration-300" />
          </div>
          <h3 class="text-2xl font-bold text-zinc-100 mb-4 group-hover:text-white transition-colors">
            {{ pillar.title }}
          </h3>
          <p class="text-zinc-400 leading-relaxed font-light">
            {{ pillar.description }}
          </p>
        </div>
      </div>
    </div>

    <!-- Additional capabilities -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
      <div
        v-for="(cap, index) in capabilities"
        :key="cap.title"
        v-motion
        :initial="{ opacity: 0, scale: 0.9 }"
        :visibleOnce="{ opacity: 1, scale: 1, transition: { duration: 600, delay: 600 + index * 150 } }"
        class="flex gap-5 p-6 rounded-2xl border border-zinc-800/40 bg-zinc-900/20 hover:bg-zinc-800/40 hover:border-zinc-700 transition-all duration-300 group"
      >
        <div class="flex-shrink-0 mt-1">
          <div class="flex items-center justify-center w-10 h-10 rounded-full bg-secondary/10 group-hover:bg-secondary/20 transition-colors duration-300">
            <UIcon :name="cap.icon" class="text-xl text-secondary" />
          </div>
        </div>
        <div>
          <h4 class="text-base font-semibold text-zinc-200 mb-2 group-hover:text-white transition-colors">
            {{ cap.title }}
          </h4>
          <p class="text-sm text-zinc-500 leading-relaxed font-light group-hover:text-zinc-400 transition-colors">
            {{ cap.description }}
          </p>
        </div>
      </div>
    </div>
  </UPageSection>
</template>

<script setup lang="ts">
const pillars = [
  {
    icon: 'i-lucide-brain',
    title: 'AI-Powered Knowledge Assistant',
    description: 'An AI that actually understands your community\'s context. It reads your events, topics, and conversations -- then helps members find answers, discover connections, and surface insights that would otherwise stay hidden.'
  },
  {
    icon: 'i-lucide-users',
    title: 'Instant Community Platform',
    description: 'Groups, events, topics, file library, and member profiles -- everything a thriving community needs, ready from day one. No plugins to install, no configurations to wrestle with.'
  },
  {
    icon: 'i-lucide-globe',
    title: 'Bioregional Sovereignty',
    description: 'Your community owns its knowledge. Hosted on your subdomain, governed by your values. No platform lock-in, no algorithm deciding what your members see. Your data stays yours.'
  }
]

const capabilities = [
  {
    icon: 'i-lucide-search',
    title: 'Hybrid Search',
    description: 'Keyword and semantic search working together -- find what you mean, not just what you type.'
  },
  {
    icon: 'i-lucide-shield-check',
    title: 'Managed Hosting',
    description: 'SSL, backups, and automatic updates included. We handle the infrastructure so you can focus on your community.'
  },
  {
    icon: 'i-lucide-sparkles',
    title: 'AI Processing Included',
    description: 'Embeddings, summaries, and intelligent search -- all included in your plan. No per-query costs.'
  }
]
</script>
