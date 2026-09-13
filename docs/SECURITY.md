# SECURITY.md

**Threat context:** a public, zero-budget platform holding modest personal data, operated by one person, running a public code repository, publishing outbound links to third-party sites, and serving a user base that is an active target for advance-fee fraud.

**Priority order:** (1) never harm a user, (2) never leak personal data, (3) never let the platform become a fraud vector, (4) keep the service available.

---

## 1. AUTHENTICATION

- **Supabase Auth**; OAuth first (GitHub, Google), email OTP second.
- No passwords are stored by this product at all — OAuth or one-time codes only. This removes credential stuffing, password reuse and password reset flows as attack surfaces entirely. `[TD]`
- OTP: 6 digits, 10-minute expiry, single use, max 5 attempts, rate-limited to 3 requests per address per hour.
- Sessions: HTTP-only, `Secure`, `SameSite=Lax`, 30-day sliding expiry, server-validated on every authenticated request.
- Session invalidation on email change, on suspension, and via "sign out everywhere".
- OAuth `state` and PKCE enforced; redirect URIs allowlisted exactly, no wildcards.
- **Admin accounts require a second factor** (TOTP) and are separate accounts from any personal account. `[PR]`

---

## 2. AUTHORISATION

**Defence in depth — every check happens twice `[PR]`:**
1. **Postgres RLS** on every table (`DATA_MODEL.md` §15) — the backstop that holds even if application code is wrong.
2. **A server-side policy module** — the primary check, with explicit tests.

Rules:
- Default deny. A new table without an RLS policy is unreachable, not public.
- The service-role key is used **only** in the batch tier and never in any request-handling path. It is never present in client code, in the public repository, or in a Worker environment reachable from the edge. `[PR]`
- Object-level checks on every mutation (owner, member, admin) — never infer permission from the fact that a UI element was rendered.
- IDOR protection: all IDs are UUIDv4; enumeration yields nothing; 404 is returned rather than 403 for objects the caller may not know exist.
- **`eligibility_profiles` has exactly one read principal: the owning user.** No admin path exists. Evaluation happens inside a security-definer function that returns a verdict and never the inputs. `[PR]`

---

## 3. INPUT HANDLING

- **Schema validation on every boundary** (Zod or equivalent) — body, query, params. Unknown fields rejected, not ignored.
- Parameterised queries only. No string-concatenated SQL anywhere, including in batch jobs.
- Length caps on every text field, enforced in the database as `CHECK` constraints as well as in the application.
- **No raw HTML from users is ever rendered.** Markdown is the only rich input, rendered through a sanitiser with a strict allowlist (no `<script>`, `<iframe>`, `<object>`, `<style>`, no event handlers, no `javascript:` or `data:` URLs).
- File uploads: logos and avatars only; MIME sniffing on content not extension; dimension and size limits; re-encoded server-side; stored under content-hashed keys with no user-controlled path component.

---

## 4. OUTBOUND LINKS — the fraud surface

The product's core function is sending people to third-party sites. That makes link handling a security feature, not a formatting concern. `[PR]`

- Scheme allowlist: `https:` only (`http:` is upgraded, and flagged if it fails).
- Every `apply_url` and `official_url` passes a **Google Safe Browsing** lookup before first display and on every re-verification.
- **Fail closed:** if Safe Browsing is unavailable, links render as plain text with an explanation, not as clickable links.
- All outbound anchors: `rel="noopener noreferrer nofollow ugc"`, `target="_blank"`.
- **Redirect-chain inspection:** an `official_url` that resolves to a different registrable domain is flagged for review — expired programme domains get bought and repurposed, which is a documented scam pattern.
- A domain denylist maintained from confirmed scam reports; matching links are blocked platform-wide.
- **Links in user messages are inert** (plain text) until both parties have exchanged at least one message, then linkified with a Safe Browsing check.

---

## 5. HEADERS AND TRANSPORT

```
Content-Security-Policy: default-src 'self';
  script-src 'self' 'nonce-{random}';
  style-src 'self' 'nonce-{random}';
  img-src 'self' data: https://{r2-domain};
  font-src 'self';
  connect-src 'self' https://{supabase-domain};
  frame-ancestors 'none';
  form-action 'self';
  base-uri 'self';
  object-src 'none';
  upgrade-insecure-requests
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(), camera=(), microphone=(), payment=(), usb=()
Cross-Origin-Opener-Policy: same-origin
```

**No `unsafe-inline`, ever.** Nonce-based, which the framework supports natively. CSP violations report to an internal endpoint (sampled, to protect the request budget).

TLS 1.2+ only, via Cloudflare. HSTS preloaded once the domain is settled.

---

## 6. SECRETS

- Secrets live in Cloudflare Worker secrets and GitHub Actions secrets. Never in code, never in the database, never in client bundles.
- **The batch repository is public** (for unlimited Actions minutes), so: secret scanning enabled, push protection on, and a documented rule that any committed secret is rotated immediately and treated as compromised regardless of how quickly it was removed. `[PR]`
- Separate credentials per environment. Preview environments never receive production credentials.
- Rotation: quarterly, and immediately on any suspicion.
- The Supabase service-role key is the highest-value secret in the system and exists in exactly one place — GitHub Actions.

---

## 7. RATE LIMITING AND ABUSE

Two layers:
1. **Cloudflare** — coarse, per IP and ASN, in front of everything. Absorbs volumetric abuse before it costs a Worker request.
2. **Postgres `rate_limit_counters`** — exact, per user and action. The table in `API_SPEC.md` §15 is authoritative.

- **Turnstile** on every unauthenticated write: public submission, report, org claim, signup, and eligibility checks above the burst threshold.
- Response to limit: `429` with `Retry-After` and a human explanation. Repeated abuse escalates to `account_state='restricted'`, never a silent block.
- Enumeration protection: uniform response times and messages on auth endpoints; no "this email exists" disclosure.

---

## 8. DEPENDENCIES AND SUPPLY CHAIN

- Lockfiles committed; `npm ci` only.
- Dependabot or Renovate with weekly security updates; critical advisories patched within 72 hours.
- `npm audit --audit-level=high` gates CI.
- **Minimal dependency posture** — the byte budget already forbids most of what would otherwise be installed, which is a security benefit as well as a performance one.
- No dependency runs a postinstall script without review.
- CI actions pinned to commit SHAs, not floating tags.

---

## 9. DATA PROTECTION IN THE SYSTEM

- TLS in transit; encryption at rest via the provider.
- **Minimisation by design**: birth *year* rather than full date of birth; city as free text rather than coordinates; no phone numbers; no document uploads; no ID verification.
- Personal data is **never sent to any LLM provider** (`AI_SYSTEM.md` §2).
- Backups are encrypted before upload to R2; the encryption key is held separately from the storage credentials.
- Logs scrub emails, tokens and IPs; Sentry runs with PII scrubbing on and `sendDefaultPii: false`.
- IP addresses are stored hashed with a rotating salt, only where required for abuse prevention, and expire after 30 days.

---

## 10. THREAT MODEL

| Threat | Likelihood | Impact | Control |
|---|---|---|---|
| Scam opportunity published under a badge | **High** | **Critical** | Anti-scam rules (`MODERATION_AND_TRUST.md` §2), no-fee policy, human gate on cost, Safe Browsing, immediate auto-dispute on report |
| Credential compromise of the operator account | Medium | Critical | TOTP on admin, separate admin accounts, audit log, session invalidation |
| Service-role key leak via public repo | Medium | Critical | Secret scanning, push protection, key in Actions secrets only, immediate rotation policy |
| Scraping of user profiles | High | Medium | Profiles private by default, no contact details stored or shown, no bulk endpoint, rate limits, `noindex` by default |
| Harassment via requests | Medium | High | Consent-before-contact, rate limits, blocking, reporting, enforcement ladder |
| Impersonation of an organisation | Medium | High | Domain-matched claims, human review of non-matching, name-collision review |
| XSS via ingested content | Medium | High | No raw HTML rendered; strict sanitiser; nonce CSP |
| SQL injection | Low | Critical | Parameterised queries only; RLS as backstop |
| IDOR | Medium | High | UUIDs, object-level checks, RLS, 404-not-403 |
| DoS / quota exhaustion as an attack | Medium | Medium | Cloudflare, Turnstile, per-action limits, hard-stop tiers that fail closed rather than bill |
| Supply-chain compromise | Low | Critical | Minimal dependencies, pinned actions, audit gate |
| Legal action from a scraped source | Low | High | Feeds and APIs first, robots honoured, no auth bypass, 48h takedown (`OPPORTUNITY_INGESTION.md` §2.1) |
| Minor accessing social features | Medium | **Critical** | 18+ gate, immediate restriction on any signal, no appeal path that restores social features |

---

## 11. INCIDENT RESPONSE

**Severity 1** (personal data exposure, scam published at scale, child-safety incident, service-role key leak) — act within 1 hour:
1. Contain: rotate keys, disable the affected surface via feature flag, take the feature offline rather than leave it exposed.
2. Assess scope from the audit log and access logs.
3. Notify affected users plainly, within 72 hours, saying what happened, what data, and what to do.
4. Notify regulators where required (`PRIVACY_AND_COMPLIANCE.md` §7).
5. Write a short public post-mortem. No spin.

**Severity 2** (targeted abuse, source compromise, prolonged outage) — same day.

A one-operator platform cannot promise 24/7 response, so the stated SLAs are honest and the **feature-flag kill switch on every non-core surface** exists precisely so containment does not require code. `[PR]`

---

## 12. SECURITY TESTING

- CI: dependency audit, secret scan, CSP header assertion, and a test suite asserting **every RLS policy** (an explicit test per table per role — this is the highest-value security test in the project).
- Automated: weekly ZAP baseline scan against preview.
- Manual, before each phase ships: authorisation matrix walkthrough, IDOR probing on every `/[id]` route, rate-limit verification, and a check that no admin surface can read eligibility profiles.
- `security.txt` published at `/.well-known/security.txt` with a contact address and a commitment to acknowledge reports within 5 days. No bounty is offered, and that is stated honestly.

---

## 13. NON-GOALS

Stated so the boundary is explicit:
- No PCI scope — no payments are processed, ever.
- No identity verification, no document uploads, no KYC.
- No health, biometric, financial or government-ID data is collected under any circumstances (`PRIVACY_AND_COMPLIANCE.md` §3).
- No end-to-end encryption of messages — threads are minimal, transitional, and explicitly designed to be handed off to Telegram or WhatsApp, which users should treat as the private channel.
