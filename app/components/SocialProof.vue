<template>
  <UPageSection
    id="communities"
    headline="Growing communities"
    title="3 communities already growing"
    description="Real communities using LocalNodes today. Visit them and see for yourself."
  >
    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
      <UCard
        v-for="(community, index) in communities"
        :key="community.name"
        v-motion
        :initial="{ opacity: 0, y: 30 }"
        :visibleOnce="{ opacity: 1, y: 0, transition: { duration: 600, delay: index * 200, type: 'spring', stiffness: 50 } }"
        class="border border-zinc-800/60 bg-zinc-900/40 backdrop-blur-xl hover:border-primary/40 hover:-translate-y-1 transition-all duration-500 group shadow-lg hover:shadow-primary/10 rounded-2xl overflow-hidden relative"
      >
        <div class="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
        
        <template #header>
          <div class="flex items-center gap-4 relative z-10">
            <div class="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center ring-1 ring-primary/20 group-hover:bg-primary/20 transition-colors duration-300 shadow-inner">
              <UIcon name="i-lucide-trees" class="text-xl text-primary/80 group-hover:text-primary transition-colors" />
            </div>
            <h3 class="text-xl font-semibold text-zinc-100 group-hover:text-white transition-colors">
              {{ community.name }}
            </h3>
          </div>
        </template>

        <p class="text-sm text-zinc-400 leading-relaxed font-light relative z-10">
          {{ community.description }}
        </p>

        <template #footer>
          <div class="relative z-10">
            <UButton
              :label="`Visit ${community.name}`"
              :to="community.url"
              target="_blank"
              variant="outline"
              size="sm"
              trailing-icon="i-lucide-external-link"
              class="group-hover:bg-primary group-hover:text-white group-hover:border-primary transition-all duration-300"
            />
          </div>
        </template>
      </UCard>
    </div>
  </UPageSection>
</template>

<script setup lang="ts">
const communities = [
  {
    name: 'Cascadia',
    description: 'Bioregional knowledge commons for the Pacific Northwest. Connecting communities across watersheds and ecosystems.',
    url: 'https://cascadia.localnodes.xyz'
  },
  {
    name: 'Boulder',
    description: 'Community knowledge garden for Boulder, Colorado. Local events, neighborhood wisdom, and civic engagement.',
    url: 'https://boulder.localnodes.xyz'
  },
  {
    name: 'Portland',
    description: 'Local knowledge network for Portland, Oregon. Neighborhood organizing, mutual aid, and community resilience.',
    url: 'https://portland.localnodes.xyz'
  }
]
</script>
