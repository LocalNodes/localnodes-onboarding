# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Marketing + onboarding site for **LocalNodes**, a hosted community site (library today; treasury and decisions coming). No price is shown on the site until Tom sets one; Stripe Checkout shows the configured price before payment. The site's job: sell the product, take payment via Stripe, then **provision a per-customer instance** by dispatching a GitHub Actions workflow in a separate product repo (`LocalNodes/os-knowledge-garden`) and surfacing live provisioning progress to the buyer. Built on Nuxt 4 + Nuxt UI v4, deployed to Vercel.

## Commands

```bash
npm run dev        # dev server at http://localhost:3000
npm run build      # production build (Nitro)
npm run preview    # preview the production build locally
npm run generate   # static generation
npm run test       # vitest run (all unit tests, once)

# single test file / filter
npx vitest run tests/unit/slugify.test.ts
npx vitest run -t "returns alreadyProcessing=true"
npx vitest            # watch mode
```

There is no lint/format script and no typecheck script wired up. `postinstall` runs `nuxt prepare` (regenerates `.nuxt` types) — run it manually after pulling if `#imports`/auto-import types look stale.

## The provisioning flow (the core of the app)

This end-to-end pipeline spans many files; understand it before touching any of them:

1. **Pick a name** — `OnboardingForm.vue` (`/onboarding`). `useSubdomain` composable debounce-slugifies the community name and checks availability via `GET /api/check-subdomain`, which queries the **Coolify API** for taken FQDNs (`*.localnodes.xyz`) and rejects a hardcoded reserved list.
2. **Checkout** — submit → `POST /api/create-checkout` creates a Stripe **subscription** Checkout session, stashing `communityName`/`subdomain`/`email` in session `metadata`, then client redirects to Stripe (`navigateTo(url, { external: true })`).
3. **Payment webhook** — Stripe fires `checkout.session.completed` → `POST /api/stripe-webhook` (verifies signature against raw body) → calls `triggerProvisioning()`.
4. **Trigger** — `server/utils/provisioning.ts`: acquires a Redis `SETNX` lock for **idempotency**, writes initial state, dispatches the `provision-instance.yml` workflow in the product repo via `server/utils/github.ts`, then updates state with the run id/url.
5. **Callbacks** — the GitHub Actions workflow POSTs progress to `POST /api/provision-callback` (authenticated by `Bearer ${provisionCallbackSecret}`), walking status through: `triggered → provisioning → installing → creating_user → sending_email → complete | failed`.
6. **Live status** — `/success?session_id=...` uses `useProvisioningStatus` to poll `GET /api/provision-status` every 3s, collapsing the 7 raw statuses into 4 user-facing `STAGES` with a 4-minute countdown, stopping on a terminal status.

### Redis state model
- Hash at `provision:{sessionId}` holds `ProvisioningState` (see `server/utils/redis.ts` for the schema). Lock lives at `provision:{sessionId}:lock`.
- Every write refreshes a 24h TTL (`PROVISION_TTL`). Missing/empty hash → status `unknown`.
- The status enum is **duplicated in three places** — `ProvisioningState` (redis.ts), `VALID_STATUSES` (provision-handlers.ts), and `RawStatus` (useProvisioningStatus.ts). Keep them in sync when adding a status.

## Conventions that matter here

- **Pure functions in `server/utils/`, thin endpoints.** Business logic (`triggerProvisioning`, `handleProvisionStatus`, `handleProvisionCallback`) takes its dependencies (redis, dispatch fn, config) as explicit args so it's unit-testable without a Nuxt/Redis runtime. The `defineEventHandler` files just wire in the real `useRedis()` / `useStripe()` / `useRuntimeConfig()` and delegate. Follow this split — don't put logic directly in the endpoint.
- **TDD is the workflow.** Git history shows a `test(...)` commit landing before each `feat(...)`. Write the failing test first. Commit messages follow `type(phase-step): description` (e.g. `feat(16-02): ...`).
- **Validation is valibot, everywhere.** Use `readValidatedBody` / `getValidatedQuery` with valibot schemas at every endpoint boundary. Subdomain rules: 3–63 chars, DNS-label regex `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`.
- **Secrets are server-only via `NUXT_*` runtimeConfig.** All keys (Stripe, Upstash, GitHub PAT, Coolify token, callback secret) come from env into `runtimeConfig` — never `public`, never reaches the client. See `.env.example`. Copy it to `.env` for local dev.
- **Lazy singleton clients.** `useStripe()` and `useRedis()` memoize a module-level instance and throw if their env vars are unset.
- **UI = Nuxt UI v4.** Compose `U*` components (`UForm`, `UPageSection`, `UButton`, `UIcon`…). `nuxt.config.ts` still defaults to `colorMode.preference: 'dark'`, but every page forces light: the landing page `/` and the task pages (`/onboarding`, `/success`, `/cancel`) set `definePageMeta({ colorMode: 'light' })`. The landing page has at most two dark bands (the hero and "Fund what matters"), each scoped with a `dark` class on its section (brand decision, Tom 2026-11-06, fresh3 `.planning/brand/BRAND.md` section 5). Theme colors (primary `ln-teal`, secondary `ln-amber`, custom hex palettes mirroring the Drupal community site, fresh3 `22-UI-SPEC.md` Part 1) in `app/app.config.ts` (Nuxt 4 only reads it from `app/`); tokens and global CSS in `app/assets/css/main.css`. Icons are Lucide (`i-lucide-*`). Animation via `@vueuse/motion`.
- **Routing/SSR is per-route** in `nuxt.config.ts` `routeRules`: `/` and `/cancel` are prerendered; `/onboarding` and `/success` are SSR.
- **Landing copy lives in the section components** (approved copy: fresh3 `.planning/brand/LANDING.md`). `content/index.yml`, `content.config.ts` and the `@nuxt/content` module were removed in 22.1-04; the `@nuxt/content` package is still in package.json, unused, until a lockfile update removes it. Every build runs `scripts/check-landing-claims.mjs` (`prebuild --stamp` records the build start; `postbuild` checks the page this build wrote, `.output/public` or `.vercel/output/static`; also `npm run check:claims`). It fails on any banned claim and on any feature whose status or chip differs from `features.items` in `tests/fixtures/banned-claims.json` (LANDING.md section 5).

## Tests

Vitest, `environment: 'node'`, files in `tests/unit/*.test.ts`. Aliases: `~` → `app`, `#app` → `.nuxt/imports` (see `vitest.config.ts`). Tests mock dependencies (a `mockRedis`, a mock dispatch fn) and assert against the pure util/composable functions rather than booting Nuxt.
