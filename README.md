# LocalNodes Onboarding

Marketing and onboarding site for **LocalNodes**, a hosted "knowledge garden" SaaS. The site sells the product, takes payment via Stripe, then **provisions a per-customer instance** by dispatching a GitHub Actions workflow in the product repo (`LocalNodes/os-knowledge-garden`) — surfacing live provisioning progress to the buyer along the way.

Built with [Nuxt 4](https://nuxt.com), [Nuxt UI v4](https://ui.nuxt.com), and [Nuxt Content](https://content.nuxt.com). Deployed on Vercel.

## How it works

```
/onboarding ──▶ check-subdomain ──▶ create-checkout ──▶ Stripe Checkout
   (form)        (Coolify lookup)     (subscription)          │
                                                              ▼
/success ◀── provision-status ◀── Redis state ◀── stripe-webhook
 (poll 3s)                              ▲          (triggerProvisioning)
                                        │                     │
                                 provision-callback           ▼
                                  (workflow ──▶ status)  GitHub Actions
                                                         (provision-instance.yml)
```

1. **Pick a name** — the onboarding form debounce-slugifies the community name and checks subdomain availability against the Coolify API (and a reserved list).
2. **Checkout** — submit creates a Stripe subscription Checkout session (community name / subdomain / email stashed in metadata) and redirects to Stripe.
3. **Webhook** — on `checkout.session.completed`, the Stripe webhook triggers provisioning: a Redis `SETNX` lock for idempotency, then a GitHub Actions workflow dispatch.
4. **Progress** — the workflow posts status back to a callback endpoint (`triggered → provisioning → installing → creating_user → sending_email → complete | failed`). The success page polls every 3s and shows a 4-minute countdown until done.

## Prerequisites

This project integrates with four external services. You'll need credentials for each:

- **Stripe** — subscription checkout + webhooks
- **Upstash Redis** — provisioning state tracking
- **GitHub** — a fine-grained PAT to dispatch the provisioning workflow on `LocalNodes/os-knowledge-garden`
- **Coolify** — API token, used to check subdomain availability

## Setup

```bash
npm install
cp .env.example .env   # then fill in the NUXT_* secrets
```

All secrets are server-only and read via `runtimeConfig` from `NUXT_*` environment variables. See [`.env.example`](./.env.example) for the full list and where to obtain each value.

## Development

```bash
npm run dev        # dev server at http://localhost:3000
npm run build      # production build
npm run preview    # preview the production build locally
npm run generate   # static generation
```

To exercise the Stripe webhook locally, forward events with the [Stripe CLI](https://docs.stripe.com/stripe-cli):

```bash
stripe listen --forward-to localhost:3000/api/stripe-webhook
```

## Testing

Unit tests run on [Vitest](https://vitest.dev) (`node` environment). Server-side business logic lives as pure, dependency-injected functions in `server/utils/`, so tests mock Redis / dispatch / config rather than booting Nuxt.

```bash
npm run test                                  # run all tests once
npx vitest run tests/unit/slugify.test.ts     # a single file
npx vitest run -t "returns alreadyProcessing" # filter by name
npx vitest                                    # watch mode
```

## Project layout

```
app/
  components/       UI sections + onboarding/provisioning components
  composables/      useSubdomain, useProvisioningStatus
  pages/            index, onboarding, success, cancel
  utils/            slugify, validation schemas
server/
  api/              endpoints (check-subdomain, create-checkout,
                    stripe-webhook, provision-status, provision-callback)
  utils/            provisioning logic, redis, stripe, github clients
content/            landing page copy (index.yml)
tests/unit/         Vitest specs
```

See [`CLAUDE.md`](./CLAUDE.md) for architecture conventions and deeper detail.
