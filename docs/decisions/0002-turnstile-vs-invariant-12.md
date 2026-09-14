# ADR 0002 — No Turnstile widget on public pages

**Status:** accepted
**Date:** 15 September 2026
**Resolves:** a direct conflict between `SECURITY.md` §3 and `README.md` §5 invariant 12

## Context

Two rules in the planning package cannot both be followed on the same page.

`SECURITY.md` §3:

> **Turnstile** on every unauthenticated write: public submission, report, org claim,
> signup, and eligibility checks above the burst threshold.

`README.md` §5, invariant 12:

> Never add a third-party script to a public page.

Turnstile's interactive widget is a script served from `challenges.cloudflare.com`,
injected into the page. The public submission form (`/submit`) and the report form
(`/report`) are public pages and unauthenticated writes, so each rule applies to both and
they disagree.

The conflict is not theoretical: the CSP in `apps/web/public/_headers` carries
`script-src 'self'` with no allowlist, so a Turnstile widget added to a page would be
blocked at runtime — working in development, silently inert in production, which is the
worst of the three outcomes.

## Decision

**Invariant 12 wins. No Turnstile widget is added to any public page.**

The invariants in `README.md` §5 are stated as absolutes and the project treats them that
way; `SECURITY.md` §3 is a control chosen to serve an end — keeping automated writes down —
and that end is served by other means here.

What carries the load instead, for each of the three public write surfaces:

| Surface | What stops abuse |
|---|---|
| `/report` (Phase 1) | 5/day per hashed IP, server-side; reports are signal for a human, never published |
| `/submit` (Phase 7) | 3/day per hashed IP; every submission lands as `draft`, which renders on no surface until a person publishes it |
| Organisation claim (Phase 7) | Signed in, 3 claims/day, and a claim grants nothing until a domain-matched email is confirmed or a human approves it |

Two things make this defensible rather than a shortcut:

1. **Nothing an unauthenticated write produces is visible to anybody.** A submission is a
   `draft`; a report is a queue row. The review queue, not the captcha, is the gate.
2. **The verification code is written and called.** `verifyTurnstile()` in
   `apps/web/src/lib/orgs.ts` checks a token whenever one arrives and
   `TURNSTILE_SECRET_KEY` is set. Cloudflare can issue Turnstile tokens from a **managed
   challenge configured at the edge**, which requires no script in the page — so the
   operator can turn on exactly the control `SECURITY.md` §3 asks for, in the one place it
   can be turned on without breaking the invariant.

## Consequences

- An operator who wants Turnstile enables it as a Cloudflare managed challenge on the
  `/submit` and `/report` routes, not by editing a template. `docs/RUNBOOK.md` says so.
- The CSP stays strict, with no CDN allowlist, and `apps/web/test/csp.test.ts` keeps it that
  way.
- If the review queue ever becomes the bottleneck — the failure mode this trades for — the
  fix is the edge challenge above, or an authenticated-only submission form. Adding the
  widget to the page is not on the list.
