<script setup lang="ts">
// Fund what matters (fresh3 LANDING.md 3.5, Tom 2026-11-06). The page's second
// and last dark band (card 7): the heading first, then the explanation and the
// list; Tom's pan.archi line closes the section as a small italic pull-quote,
// unattributed, so no two slogan lines sit back to back. Pre-launch (Tom,
// 2026-11-06, PR #9): the finished product in the present tense, no chips.
// TODO(22.1-08): the exact band colour (palette B brand 950) and its muted
// role arrive through the Nuxt dark tokens in 22.1-08; the `dark` class scopes
// them here.
const items = [
  { title: 'See your group fund.', body: 'Link the group\'s shared account and see its real balances and who approves payments.' },
  { title: 'Decide together.', body: 'Proposals and votes by your group\'s members, and a passed proposal carried out through the group fund.' },
  { title: 'Rules only your members can change.', body: 'Voting settings change only after a passed vote.' },
  { title: 'Credit for the work people do.', body: 'A public record of members\' contributions.' },
  { title: 'Fair moderation and a way to settle disputes.', body: 'Every step has an end date and an appeal, and disputes go to a panel of members.' },
  { title: 'Bring what you already have.', body: 'Connect an existing shared account, roles or voting space, nothing redeployed.' },
  { title: 'Leave whenever you want.', body: 'Export everything and move your site.' },
  { title: 'No fees for members.', body: 'Members never pay network fees to vote or approve; the community covers them.' }
]
</script>

<template>
  <section class="dark bg-default text-default">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 sm:py-20 flex flex-col gap-6">
      <h2 class="text-3xl font-semibold text-highlighted">
        Fund what matters. Decide together. Own the infrastructure.
      </h2>
      <p class="text-lg text-muted">
        LocalNodes keeps your group's shared money and decisions alongside its
        library: members see the fund, vote on proposals and keep a public record
        of what was decided.
      </p>
      <ul class="flex flex-col">
        <li
          v-for="item in items"
          :key="item.title"
          class="flex flex-wrap items-baseline justify-between gap-3 border-b border-default py-3"
        >
          <span class="flex-1 basis-80 min-w-0">
            <span class="font-semibold text-highlighted">{{ item.title }}</span>
            {{ ' ' }}
            <span class="text-muted">{{ item.body }}</span>
          </span>
        </li>
      </ul>
      <blockquote class="mt-4 max-w-3xl">
        <p class="text-lg italic text-muted">
          Governance should adapt to people, not people to governance.
        </p>
      </blockquote>
    </div>
  </section>
</template>
