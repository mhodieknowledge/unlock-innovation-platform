# ADR 0001 — Astro + Svelte islands instead of Next.js

**Status:** accepted
**Date:** 13 September 2026
**Supersedes:** `SYSTEM_ARCHITECTURE.md` §3.1 primary choice, and row 2 of its §20 decision log

## Context

`SYSTEM_ARCHITECTURE.md` §3.1 selects **Next.js 15 App Router on Cloudflare via
OpenNext**, and rejects Astro + Svelte islands with this reasoning:

> Genuinely lower JS and better for the byte budget. Rejected because a single
> framework is materially easier for a coding agent to build and maintain
> consistently, and RSC gets us most of the way. **Revisit if byte budgets fail
> in testing.**

That is a conditional decision with an explicit trigger. This ADR records the
measurement that fired the trigger.

`PRODUCT_SPEC.md` §25.1 sets the opportunity detail budget at **≤120 KB total
transferred, gzipped, first visit** and **≤30 KB JS executed**. Invariant 5
(`README.md` §5) makes exceeding a byte budget a defect, not a trade-off, and
§25.1 is marked `[PR]`.

## Measurement

Both spikes render the same opportunity detail page — identical copy, identical
CSS, the full information hierarchy of `UX_FLOWS.md` §4 (title, organisation,
countdown, verdict block with four quoted rules, actions, 8-cell fact grid,
summary, three description paragraphs, eligibility in full, provenance, related,
report link). Measured as gzip -9 over the built artefacts.

| Variant | HTML+CSS gz | JS gz | Total gz | vs 120 KB | vs 30 KB JS |
|---|---|---|---|---|---|
| Next.js 15.5.4, **zero client components** | 4.9 KB | 138.0 KB | **142.8 KB** | ✗ 119% | ✗ 460% |
| Next.js, excluding legacy polyfills | 4.9 KB | 99.6 KB | 104.5 KB | ✓ 87% | ✗ 332% |
| Astro 5.14.1, no island | 2.5 KB | 0 KB | **2.5 KB** | ✓ 2% | ✓ 0% |
| Astro + Svelte 5 eligibility island, full import closure | 4.4 KB | 11.4 KB | **15.7 KB** | ✓ 13% | ✓ 38% |

Next.js App Router's floor comes from `react-dom` plus the App Router runtime:
two shared chunks of 45.9 KB and 54.1 KB gzipped, loaded on every route. There is
no supported zero-hydration mode, so that floor applies even to a page with no
interactivity at all. Stripping the script tags post-build is not viable — the
eligibility checker is required to be a client island (`SYSTEM_ARCHITECTURE.md`
§3.2), so the runtime would be needed back the moment it renders.

The gap is not marginal and cannot be closed by tuning. Astro leaves **8×
headroom** on the JS budget where Next.js needs a 4.6× reduction that its
architecture does not permit.

## Decision

Build the web app as **Astro 5 with Svelte 5 islands**, deployed to Cloudflare
Workers via `@astrojs/cloudflare`.

The rejection reasoning in §3.1 was about agent maintainability, not capability,
and it was explicitly conditional. The condition is now met with evidence. An
invariant marked non-negotiable outranks a convenience preference.

## Consequences

**Unchanged.** Everything else in `SYSTEM_ARCHITECTURE.md` survives intact,
because the framework was never load-bearing for the rest of the design:

- Static-first rendering (§1, §3.2) — Astro's default output is static; the
  route/revalidate table maps onto prerendered pages plus on-demand SSR routes.
- The eligibility verdict as a client island posting to
  `POST /api/eligibility/evaluate`, with page HTML identical for every viewer and
  fully cacheable (§3.2) — implemented exactly as specified, and measured above.
- Islands-only interactivity (§3.3), Tailwind with tokens-only, no component
  library at runtime, no third-party scripts.
- Cloudflare Workers request tier, GitHub Actions batch tier, Supabase data tier,
  the AI provider chain, ingestion, notifications — all untouched.

**Changed:**

- **OpenNext is not used.** `@astrojs/cloudflare` is the adapter.
- **No RSC or server actions.** Astro components render on the server by default;
  mutations go through API route handlers, which `API_SPEC.md` already defines as
  the contract the Telegram bot and RSS also consume. The spec's server-action
  mentions become route handlers.
- **§20 decision log row 2** is superseded by this ADR.

**Retained risk:** Svelte is less familiar territory than React for a coding
agent, which is the concern §3.1 raised. Mitigations: islands are small and few
(§3.3 lists six), all business logic lives in framework-free packages such as
`@mbele/eligibility`, and the byte-budget CI check makes any regression a build
failure rather than a discovery in production.

## Verification

The byte-budget check in CI (`scripts/byte-budget.mjs`) enforces
`PRODUCT_SPEC.md` §25.1 per route on every build, so this decision stays honest
rather than resting on a one-off measurement. Phase 0's acceptance criterion —
"CI **fails** a deliberately oversized bundle" — tests the check itself.
