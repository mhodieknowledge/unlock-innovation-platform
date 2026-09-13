# PRIVACY_AND_COMPLIANCE.md

**Additional document, not in the brief's required list.** Added because the product collects personal data from users across multiple African jurisdictions with active data protection regimes and extraterritorial reach, and because it enables user-to-user contact. Treating this as a footnote would be a design error.

**This is directional guidance, not legal advice.** Local counsel is required before scaling into any specific market or monetising.

---

## 1. PRIVACY POSTURE

**Minimisation is the primary control.** The cheapest way to protect data is not to hold it.

| We collect | We deliberately do not |
|---|---|
| Email (for auth and notifications) | Phone numbers |
| Country of residence, nationalities | Precise location or coordinates |
| Birth **year** | Full date of birth |
| Student status, year of study, institution name | Student ID numbers or documents |
| Skills, technologies, interests | CVs, transcripts, certificates |
| Optional gender (only for gender-restricted rules) | Race, ethnicity, religion, health, disability, political views |
| Telegram chat ID (if linked) | Contact lists, address books |
| Hashed IP for abuse control, 30 days | Persistent advertising identifiers |

**No cross-site tracking, no advertising, no data sale, no third-party analytics scripts, no non-essential cookies.** Because no non-essential cookie is set, no consent banner is required — which is also a byte-budget win. `[PR]`

---

## 2. THE ELIGIBILITY PROFILE — the sensitive core

It contains country, nationality, age band, student status and optionally gender. In combination that is identifying and, in some contexts, sensitive.

**Controls `[PR]`:**
1. **Exactly one read principal: the owning user.** Enforced in RLS. No admin path exists.
2. Evaluation runs in a security-definer function returning a **verdict only**, never the inputs.
3. **Never sent to any AI provider.** Matching uses embeddings of public profile text; eligibility uses a deterministic rules engine. No LLM ever sees a user's personal fields.
4. Never displayed on any profile, in any room, in any search result, at any visibility level.
5. Every field optional; missing fields produce `unclear`, never a block.
6. **Anonymous checks are never persisted.** Logged-out users' inputs stay in localStorage and are posted per request.
7. `gender` exists only because women-in-tech programmes are a real and important category. It is optional, self-declared, never inferred, never used for anything except evaluating a `gender_restricted` rule, and never displayed.

---

## 3. SPECIAL CATEGORIES — never collected `[PR]`

Race, ethnicity, religion or belief, political opinions, trade union membership, health or disability data, biometric or genetic data, sexual life or orientation, criminal history, government identification numbers, financial account details.

If an opportunity's eligibility rules depend on one of these (for example a disability-specific fellowship), the rule is displayed with its source quote and evaluated as **`unclear`** with a note: *"This has a requirement we don't ask about. Check the official page."* We surface the opportunity; we do not collect the attribute. `[PR]`

---

## 4. LAWFUL BASIS

| Processing | Basis |
|---|---|
| Account, auth, core service | Contract |
| Eligibility profile and verdicts | Consent — granular, revocable, explained at the point of entry |
| Digests and deadline reminders | Consent — opt-in, per type, one-tap withdrawal |
| Security, abuse prevention, rate limiting | Legitimate interests |
| Aggregate analytics | Legitimate interests, non-identifying, first-party only |
| Public profiles and projects | Consent — off by default, explicit opt-in per visibility level |

Consent is never bundled. Declining any consent leaves the core product fully usable.

---

## 5. USER RIGHTS `[PR]`

All self-serve where possible; no support ticket required.

| Right | Implementation |
|---|---|
| Access | `/you/account` → Export my data → JSON of everything held, emailed or downloaded |
| Rectification | Every field editable in place |
| Erasure | Self-serve deletion; 30-day grace with immediate deactivation; user chooses whether public content is anonymised or removed |
| Restriction | Account pause — retains data, stops all processing except security |
| Portability | JSON and CSV export of tracker, projects, profile |
| Objection | Per-type notification opt-outs; opt out of recommendations entirely |
| Withdraw consent | Any consent revocable in one action, with the effect stated plainly |

**What survives deletion**, stated in the policy: aggregate non-identifying counts, moderation records where there was a confirmed safety violation (retained 24 months for the protection of others), and messages already delivered to another user's inbox — which are that person's data too. Each is justified rather than merely listed.

---

## 6. JURISDICTIONS

The product deliberately targets many countries, so several regimes apply at once. Verified during research:

| Jurisdiction | Instrument | Key obligation |
|---|---|---|
| **Nigeria** | NDPA 2023 | **Extraterritorial.** "Data Controller of Major Importance" includes processing personal data of **more than 200 data subjects within six months**, or operating in listed sectors. Registration fee ₦100,000; DPO required for major-importance controllers; penalties up to **₦10M or 2% of annual gross revenue**. |
| **Kenya** | DPA 2019 | Registration with the ODPC subject to thresholds; cross-border transfer rules |
| **South Africa** | POPIA | Consent, purpose limitation, security safeguards, data-subject rights; Information Regulator enforcement |
| **Ghana** | DPA 2012 | Registration with the Data Protection Commission |
| **Zimbabwe** | Cyber and Data Protection Act 2021 | Data controller registration/licensing under POTRAZ |
| **EU/UK** | GDPR | Applies if EU/UK users are targeted or monitored |

**The uncomfortable fact `[C]`:** Nigeria's 200-data-subjects-in-six-months threshold is low. A product that reaches modest early traction across African markets crosses it quickly. Full multi-country registration — DPO appointments, local registrations, fees in several jurisdictions — is not realistically achievable by a zero-budget solo operator.

---

## 7. MINIMUM-VIABLE COMPLIANCE

Achievable at $0, and it is what a serious small operator should actually do. `[PR]`

**Before any public launch:**
1. Plain-language privacy policy — what, why, how long, who else sees it, your rights, how to contact.
2. Terms of use, including the anti-scam statement and the 18+ requirement.
3. Cookie statement (short — only essential cookies are set).
4. A named contact address for privacy requests, published and monitored.
5. Data-minimisation review of every field against §1.
6. Self-serve export and deletion, working and tested.
7. Encryption in transit and at rest; encrypted backups.
8. A documented breach-response process with a 72-hour notification target.
9. A crawler page at `/bot` and a published takedown process (`OPPORTUNITY_INGESTION.md` §2.1).
10. A record of processing activities — a single maintained document, not a formal ROPA, but honest and current.

**At the first growth threshold (approaching 200 Nigerian data subjects, or ~1,000 users overall, or any monetisation):**
11. Take local legal advice, starting with Nigeria and Kenya.
12. Register where required; budget the fees as a real cost.
13. Appoint a DPO or designate the operator formally.
14. Review cross-border transfer posture — data sits on Cloudflare and Supabase infrastructure, which means transfers out of several of these jurisdictions.
15. Publish a data-processing addendum for any organisation partners.

**Honest statement of the gap:** between launch and step 11, the product is likely operating below full registration compliance in at least one jurisdiction. That is a real risk, it is documented here rather than hidden, and the mitigation is to reach step 11 early rather than to pretend the obligation does not exist. `[C]`

---

## 8. RETENTION

| Data | Retention |
|---|---|
| Account and profile | Life of account + 30-day deletion grace |
| Eligibility profile | Life of account; deleted immediately on request, independently of the account |
| Tracker and notes | Life of account |
| Messages | 60 days after last activity → thread closes; deleted 90 days later |
| Declined requests | 90 days |
| Raw events | 30 days, then rolled up to non-identifying daily aggregates |
| Hashed IPs | 30 days |
| Moderation records (confirmed violations) | 24 months |
| Admin audit log | 24 months |
| `raw_documents` | 90 days in database, then archived to R2 (also a storage measure) |
| Backups | 14 days |

Retention is enforced by a scheduled job, not by policy alone. A retention rule nobody executes is not a retention rule. `[PR]`

---

## 9. THIRD-PARTY PROCESSORS

| Processor | Data | Location | Note |
|---|---|---|---|
| Supabase | All application data | Region-selected — **choose the closest available region and document it** | Sub-processor of AWS |
| Cloudflare | Traffic, cached content, R2 objects, KV | Global edge | Processor |
| Brevo | Email addresses, message content | EU | Processor |
| Telegram | Chat ID, message content | Global | **User-initiated**; the user's own relationship with Telegram applies, stated plainly at link time |
| GitHub | Batch execution, secrets | US | Processor |
| Sentry | Scrubbed error data | EU region selected | PII scrubbing enforced |
| Google Safe Browsing | URLs checked (not user data) | US | No personal data sent |
| LLM providers | **Public web content only** | Various | **No user data, ever** `[PR]` |

The LLM row is the one most likely to be violated by a careless future change, so it is stated as an invariant in `AI_SYSTEM.md` §2 and enforced in routing code, not left to discipline.

---

## 10. CHILDREN

Accounts are 18+ (`PRODUCT_SPEC.md` §22.1, `MODERATION_AND_TRUST.md` §8).

Opportunities open to under-18s — and there are real, valuable ones, such as the Anzisha Prize at 15–22 and ALX's high-school categories — remain **fully listed and readable without an account**, with a clear note. A 16-year-old can find the opportunity, read the eligibility rules and apply on the official site. They simply cannot create an account, declare intent, join a team or message anyone here.

This is a deliberate trade: some utility is lost so that a solo-operated platform is not running an unmoderatable contact surface for minors. It is stated in the terms, on the affected listings, and in the privacy policy.

---

## 11. TRANSPARENCY

Published and kept current: privacy policy, terms, cookie statement, content policy, anti-scam page, verification explainer, crawler and takedown page, `security.txt`, and a changelog of material policy changes with the date and a one-line summary of what changed.

Users are notified in-app of any material privacy-policy change **before** it takes effect, with a plain summary — not a link to a diff.
