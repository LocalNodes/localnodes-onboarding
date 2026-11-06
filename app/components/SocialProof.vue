<script setup lang="ts">
// See it in action (fresh3 LANDING.md 3.6 and section 4, approved by Tom
// 2026-11-06). Example groups are examples, never customers; every demo-site
// link says "demo" in its visible text (D-16). No testimonials, community
// list or numbers. Pre-launch (Tom, 2026-11-06, PR #9): each example reads as
// the finished product, in the present tense, with no chips.
const examples = [
  {
    title: 'A housing co-op',
    body: 'Keeps its bylaws, house rules, minutes and maintenance records in its library; members ask "When was the roof last inspected?" and get the answer with the minutes it came from. Sees its repair fund\'s balance and who approves spending, and votes on a major repair, then carries out the payment once it passes.'
  },
  {
    title: 'An online guild',
    body: 'Keeps its handbook, past proposals and project write-ups in one place new members can ask about. Connects the shared account and voting it already uses, nothing redeployed, and records members\' contributions.'
  },
  {
    title: 'A land trust',
    body: 'Holds deeds, stewardship plans, surveys and meeting notes, private to its stewards where it needs to be. Votes on land-use decisions with a public record, and settles disagreements through a member panel.'
  },
  {
    // Replaces the Drupal user group example (Tom, 2026-11-06: too niche).
    title: 'A neighborhood association',
    body: 'Shares news and events as posts on its own site instead of a social media group, and keeps its minutes and bylaws where members can ask "When is the next block cleanup?" and get the answer with the minutes it came from. Collects dues or runs a mutual aid fund that several members approve, and votes on which neighborhood projects to take on.'
  },
  {
    title: 'A bioregional network',
    body: 'Its member groups each run a group on one site, sharing a library while keeping private pages private. Holds community-wide votes with one vote per member group.'
  }
]

// Both returned HTTP 200 on 2026-11-06 (re-checked by 22.1-04 before shipping).
const demos = [
  { name: 'Cascadia (demo)', host: 'cascadia.localnodes.xyz', url: 'https://cascadia.localnodes.xyz' },
  { name: 'Boulder (demo)', host: 'boulder.localnodes.xyz', url: 'https://boulder.localnodes.xyz' }
]
</script>

<template>
  <section class="bg-muted">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 sm:py-20 flex flex-col gap-6">
      <h2 class="text-3xl font-semibold text-highlighted">
        See it in action
      </h2>
      <p class="text-lg text-muted">
        Here's how a few kinds of groups would use it. These are examples, not customers.
      </p>
      <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <div
          v-for="example in examples"
          :key="example.title"
          class="bg-default rounded-lg border border-default p-5 flex flex-col gap-2.5"
        >
          <span class="self-start rounded-full border border-accented px-2.5 py-0.5 text-xs text-muted">Example</span>
          <h3 class="text-lg font-semibold text-highlighted">
            {{ example.title }}
          </h3>
          <p class="leading-relaxed text-muted">
            {{ example.body }}
          </p>
        </div>
      </div>

      <h3 class="text-xl font-semibold text-highlighted mt-6">
        Try a demo site
      </h3>
      <p class="text-muted">
        These are demo sites with sample content, so you can see a LocalNodes
        community before launch.
      </p>
      <div class="grid gap-4 md:grid-cols-2">
        <a
          v-for="demo in demos"
          :key="demo.url"
          :href="demo.url"
          target="_blank"
          rel="noopener noreferrer"
          class="group bg-default rounded-lg border border-default p-5 flex flex-col gap-2 transition-colors duration-150 ease-out hover:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <span class="font-semibold text-highlighted">{{ demo.name }}</span>
          <span class="text-muted">Demo: a sample community site with groups, events and an AI assistant.</span>
          <span class="inline-flex items-center gap-1 text-primary underline">
            {{ demo.host }}
            <UIcon name="i-lucide-external-link" class="size-4" aria-hidden="true" />
            <span class="sr-only">(opens in a new tab)</span>
          </span>
        </a>
      </div>
    </div>
  </section>
</template>
