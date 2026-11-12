<script setup lang="ts">
// The closing band: a dark band with the words and the Boulder demo link on the left, the
// early-access form in a card on the right, and below them the privacy note the form links to. The page's launching-soon
// statement is in the hero, so this band does not repeat it.
// The sentence about sign-in links, Upstash and Stripe in the "Where" item is
// Tom's own text (TA-2, 2026-11-08), with "encrypted" corrected to "a scrambled
// form" because the invite list is a keyed hash. Change it only with Tom.
</script>

<template>
  <section id="early-access" class="home-close home-dark dark bg-default">
    <div class="home-wrap">
      <div class="home-close-grid">
        <div class="home-close-words">
          <h2 class="home-h2">
            Be one of the first communities in.
          </h2>
          <p class="home-sub">
            Leave an email address and we'll write when sign-up opens. You can also look around a demo site first.
          </p>
          <a
            id="demo"
            href="https://boulder.localnodes.xyz"
            target="_blank"
            rel="noopener noreferrer"
            class="home-link scroll-mt-20"
          >Look around the Boulder demo site (a demo)<span class="sr-only"> (opens in a new tab)</span></a>
        </div>

        <div class="home-close-form">
          <EarlyAccessForm popup-class="dark home-dark" />
        </div>
      </div>

      <div id="privacy" class="home-privacy scroll-mt-20">
        <h3>
          Privacy
        </h3>
        <ul>
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
            service we use to send launch news. When you ask for a sign-in link, we keep your email on
            Upstash so the link only works for you: the link lasts 15 minutes, and once you sign in, you
            stay signed in for up to two hours. Our invite list keeps only a scrambled form of each address. If you
            set up a site, its setup and payment records are kept separately, with us and with Stripe.
            Stripe handles your card details at checkout; LocalNodes
            never sees or stores them.
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
