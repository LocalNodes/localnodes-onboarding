<script setup lang="ts">
// Early access (fresh3 LANDING.md 3.9). Pre-launch (Tom, 2026-11-06, PR #9):
// the closing section repeats the pre-launch statement (`data-prelaunch`) and
// holds the early-access form and the privacy note it links to.
// The privacy wording is a draft for Tom's approval (legal wording is his
// call); see the PR #9 report.
</script>

<template>
  <section class="bg-default">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20 flex flex-col items-center gap-6 text-center">
      <h2 class="text-3xl sm:text-4xl font-semibold text-highlighted text-balance">
        Give your community a home base
      </h2>
      <p data-prelaunch class="text-lg text-muted">
        <span class="font-semibold text-highlighted">Launching soon.</span>{{ ' ' }}
        <ULink to="#see-it-in-action" class="text-primary underline underline-offset-2">See the demo</ULink>
        or <ULink to="#early-access" class="text-primary underline underline-offset-2">get early access</ULink>.
      </p>

      <EarlyAccessForm />

      <div id="privacy" class="w-full max-w-xl mt-6 flex flex-col gap-3 text-left scroll-mt-20">
        <h3 class="text-lg font-semibold text-highlighted">
          Privacy
        </h3>
        <ul class="flex flex-col gap-2 text-sm leading-relaxed text-muted list-disc pl-5">
          <li>
            <span class="font-semibold text-default">What we keep:</span> your email address, and your
            community's name and kind of group if you give them.
          </li>
          <li>
            <span class="font-semibold text-default">Why:</span> only to send you news about the
            LocalNodes launch and early access. We don't sell it or share it with anyone for marketing.
          </li>
          <li>
            <span class="font-semibold text-default">Where:</span> on our list at Resend, the email
            service we use to send launch news.
          </li>
          <li>
            <span class="font-semibold text-default">Spam protection:</span> we keep a scrambled form of
            your IP address for one hour, to limit repeated sign-ups. Never your email.
          </li>
          <li>
            <span class="font-semibold text-default">Leaving the list:</span> every email has an
            unsubscribe link. Use it any time and we stop writing to you.
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>
