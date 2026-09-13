# COLLABORATION_SYSTEM.md

Covers everything person-to-person that is **not** opportunity-scoped team formation (that is `TEAM_FORMATION.md`): projects, collaboration requests, threads, handoff and blocking.

**Governing principle `[PR]`:** consent before contact. No identifier, no thread, no notification of interest reaches anyone who has not agreed to it in that specific context.

---

## 1. PROJECTS

### 1.1 Why projects exist
Not as portfolio ornaments. A project's payoff, in priority order:
1. **It unlocks opportunities** — "your project matches 4 open calls you're eligible for." This is the novel thing; nobody else does it.
2. It attracts collaborators, once density allows.
3. It becomes a durable record.

A project at `private` visibility still receives opportunity matches. **That is the point** — the feature is valuable to a user with nobody else on the platform. `[PR]`

### 1.2 Creation
Minimum to create: title and one-line pitch. Everything else is progressive.

Fields: `title` ≤120, `pitch` ≤200, `problem` ≤2000, `solution` ≤2000, `target_users` ≤500, categories, industries, skills used, technologies, `roles_needed[]`, repo/demo/docs URLs, country, state, visibility.

On save the system computes an embedding and runs a **synchronous first-pass match**, so the user sees matched open calls within seconds of creating the project. This immediacy is the feature's hook. `[PR]`

### 1.3 Lifecycle
`idea → looking_for_collaborators → team_forming → building → testing → launched → completed`, plus `paused` and `archived`.

Transitions are manual. Inactivity handling: prompt at 120 days, auto-`paused` at 180 days. **Never auto-delete.** A paused project is hidden from public browse but keeps receiving matches for its owner.

### 1.4 Visibility
| Level | Who sees it | Indexable |
|---|---|---|
| `private` (default) | Owner and members only | No |
| `unlisted` | Anyone with the link | No |
| `public` | Everyone | Only if `indexable=true`, which is a separate opt-in `[PR]` |

Public browse of projects is gated by a density floor of 40 public projects platform-wide. Below that, projects are a private tool only. `[PR]`

### 1.5 Project → opportunity matching
Nightly, plus on edit. Uses the same gate-then-similarity mechanic as user recommendations, with the **owner's** eligibility profile applied:

```
gate:  published, open, verdict(owner) ∈ {eligible, likely_eligible}
score: 0.55·cosine(project.embedding, opportunity.embedding)
     + 0.30·urgency
     + 0.15·tag_overlap
cap:   top 10, max 2 per organisation
```

Displayed as a list with templated reasons: *"AgriTech · AI · open to Zambia · closes in 12 days."* Each carries the eligibility verdict for the owner and a one-tap track action.

### 1.6 Opportunity → project
On an opportunity page, show matching **public** projects and teams seeking members — only at a density floor of 3 matching public projects. Below that, the section does not exist. `[PR]`

---

## 2. COLLABORATION REQUESTS

### 2.1 Contexts
A request must always be attached to a context. **There is no context-free "connect" action anywhere in the product.** `[PR]`

| Context | Initiator | Target |
|---|---|---|
| `team_request` | Builder | Team owner |
| `project_role` | Builder | Project owner |
| `opportunity_intent` | Builder with intent | Another builder with intent on the same opportunity |

### 2.2 Request contents
`role_id` (what they'd do) plus a message ≤500 characters. Nothing else. No attachments, no links in the first message (links are stripped and shown as plain text until the connection is accepted — a standard anti-phishing measure). `[PR]`

### 2.3 States
`pending → accepted | declined | withdrawn | expired`.
Expiry: 14 days, or 72 hours before the related deadline, whichever is sooner.

### 2.4 Rate limits `[PR]`
10/day, 3/hour, 5 pending at once, one per (target, context). Identical message to >3 targets within an hour → soft warning, then a 24-hour cooldown.

### 2.5 On decline
The requester is told, without a reason. No re-request to the same target/context for 7 days. Declines are never surfaced publicly or counted anywhere visible.

---

## 3. THREADS

### 3.1 Opening
A thread opens **only** on acceptance. There is no way to message anyone who has not accepted a request from you. `[PR]`

### 3.2 Deliberate minimalism
- Text only, ≤2000 characters per message.
- No attachments, no images, no voice.
- **No realtime.** Polling with `If-Modified-Since` on thread open and every 30 seconds while the thread is focused.
- No typing indicators, no read receipts, no presence.
- Links rendered as plain text until both parties have exchanged at least one message each, then linkified with a Safe Browsing check.

Every omission here is deliberate: each costs bytes (the byte budget), moderation surface (the operator-load principle), or both. We are not building a messenger; we are building a doorway to one.

### 3.3 Handoff — the intended exit `[PR]`
Prominent in every thread: *"Move this to Telegram or WhatsApp?"*

Flow: A proposes a channel → B accepts → **only then** are identifiers exchanged, and only the one channel chosen. Either side can decline without explanation. Declining does not close the thread.

This is the designed outcome, not a leak. Real collaboration will happen on WhatsApp, Telegram and Discord regardless — the honest design is to hand off cleanly with consent rather than to trap people in a worse chat product.

### 3.4 Closure
Threads close when the related team disbands, the project is archived, either party blocks, or 60 days after the last message. Closed threads are read-only for 90 days, then messages are deleted and only the fact of the connection remains.

---

## 4. BLOCKING AND SAFETY

**Blocking is absolute and immediate `[PR]`:**
- Blocked user cannot see the blocker's profile, projects, teams, intents or room presence.
- Blocker disappears from the blocked user's every surface, including rooms they both occupy.
- All pending requests between them are cancelled; threads close.
- Blocks are never revealed — the blocked user sees absence, never an explanation.
- Blocking is one-tap from every profile, request, thread and room listing.
- Block lists are private and never inferable through counts or ordering.

Reporting is separate from blocking and always available alongside it.

---

## 5. PUBLIC BUILDER PROFILES

### 5.1 Default off `[PR]`
Public profiles are opt-in. A user can use the entire opportunity product — search, eligibility, tracker, digests, Telegram — with no public profile at all.

### 5.2 Contents when public
Display name, handle, country, headline, bio, skills, technologies, interests, `open_to[]`, availability, public projects, and team memberships the user chose to show.

**Never shown, at any visibility level:** email, phone, Telegram handle, precise location, date of birth, any eligibility-profile field, tracker contents, saved items, intent outside its room, connection history. `[PR]`

### 5.3 Discovery
- **Phase 1:** no global builder index. Profiles are reachable only from a room, a project, a team or a direct link.
- **Later:** a searchable index unlocks at ≥250 public profiles **and** ≥1,000 MAU, and includes only `public` profiles. Until both are met, the feature does not exist in the UI.

### 5.4 Anti-scraping
Public profile pages: `noindex` unless `indexable=true`; rate-limited; no bulk endpoint; contact details structurally absent so there is nothing worth harvesting. `[PR]`

---

## 6. OPERATOR-LOAD BUDGET

Every collaboration feature is measured against the operator-load principle. Estimated daily moderation load at 1,000 MAU:

| Surface | Expected items/day | Handling |
|---|---|---|
| Requests | ~40 | Automated rate limits; reports only |
| Messages | ~120 | Pre-screen; reports only |
| Public projects | ~3 | Pre-screen + spot check |
| Profiles | ~5 | Pre-screen on bio/links |
| Reports | ~2 | Human, ≤24 h SLA (≤12 h for scam) |

**Design target: ≤30 minutes/day.** If a proposed feature would push this past 30 minutes, it is redesigned or removed. This is the criterion that removed open DMs, a public activity feed and open builder browse from the product. `[PR]`
