# TEAM_FORMATION.md

**The design problem this solves:** every previous attempt at cross-platform hackathon team matching has failed. Devpost's own project archive contains a long tail of them — TeamFinder, HackTeam, Find Your HackathonMates, "AI-powered team formation platform" — and independent builds like DevMatchups sit unused on GitHub. They fail for three structural reasons:

1. **No liquidity at the moment of need.** A directory of builders is empty precisely when someone needs it.
2. **The host platform owns the registrant list.** Devpost has a Participants tab and a "Projects → Open for team building" filter; HackerEarth has a "Looking for teammates" toggle. We cannot see who registered, so we cannot beat them on their own events.
3. **The need is spiky and short-lived**, so nobody maintains a profile between events.

This specification is designed around those three failures rather than in spite of them.

---

## 1. THE THREE DESIGN MOVES

### Move 1 — Anchor to the opportunity, never to a directory `[PR]`
There is no browsable list of builders. A person becomes visible to others **only** inside the room for a specific opportunity they have declared intent on, and **only** while that opportunity is open. A room with four people is useful. A directory with four people is embarrassing. Same four people, opposite signal.

### Move 2 — Intent as the primitive `[PR]`
"I'm going for this" is a low-cost, honest, time-bounded declaration. It is the platform's most valuable proprietary signal: **nobody else knows who is planning to enter what, before the deadline.** Host platforms know who *registered*; we know who *intends*, which is earlier and more actionable.

### Move 3 — Don't fight the host platform `[PR]`
Team rooms are **enabled by default** for opportunities with no host team tooling: grants, fellowships, local and university competitions, national challenges, accelerator cohorts. For opportunities hosted on Devpost, MLH, HackerEarth, Devfolio, Unstop or DoraHacks, the room is shown with a prominent link to the host's own teammate tooling, and our room is positioned as a *pre-registration* space for people in the same country or timezone. We add what they lack — geography and eligibility — instead of duplicating what they have.

---

## 2. INTENT

### 2.1 Declaring
On any published, open opportunity, a signed-in 18+ user chooses exactly one stance:

| Stance | Meaning | Appears in room as |
|---|---|---|
| `going_solo` | Entering alone | Counted only |
| `looking_for_team` | Wants to join or form a team | Listed in "Builders looking for a team" |
| `have_team_looking_for_roles` | Has a team, needs roles | Prompted to create a team |
| `just_interested` | Watching | Counted only |

Optional: `roles_offered[]` and a note ≤300 characters.

### 2.2 Rules `[PR]`
- One intent per user per opportunity; changing stance updates it.
- `expires_at` is set server-side to the opportunity's deadline. **Intent is never permanent.** No stale profiles.
- Intent is visible **only inside that opportunity's room** — never on a profile, never in search, never in another room.
- Withdrawable at any time, immediately and completely.
- Declaring intent does **not** create a public profile. It exposes: display name, country, headline, roles offered and the note. Nothing else, ever.
- Anyone with `account_state != 'active'` or without 18+ confirmation cannot declare intent.

### 2.3 Aggregate display `[PR]`
Intent count is shown publicly on the opportunity page **only at ≥5**. Below that, no number is shown at all — not "0", not "2". Showing a low number is worse than showing nothing.

At ≥5 the page shows: *"14 builders have said they're going for this."* This is trust and momentum signalling, and it is the one social proof the product uses.

---

## 3. TEAM ROOMS

### 3.1 Availability
| Condition | Room state |
|---|---|
| Opportunity closed or expired | Archived, read-only |
| `< 3` intents and `0` teams | **Not shown.** CTA only: "Be the first to say you're going for this." |
| `≥ 3` intents or `≥ 1` team | Room opens |
| Host platform has team tooling | Room opens with a link-out banner to the host's tooling |

### 3.2 Contents
1. **Header** — opportunity title, deadline countdown, the team-size rule from the opportunity itself, and the user's own eligibility verdict.
2. **Open teams** — name, pitch, roles still needed, current size / max, country mix, a "Request to join" action.
3. **Builders looking for a team** — display name, country, roles offered, note, "Invite to my team" (team owners only) or "Send a request" (if the viewer has a team).
4. **Your status** — your intent, your team, your pending requests.

**Not present:** chat, feed, activity stream, likes, follower counts, online indicators, "X viewed your profile". `[PR]`

### 3.3 Archival
When the opportunity closes, the room becomes read-only. Teams keep their record. Members may add the team to their profile if it reached `submitted`. Intents deactivate. Nothing is deleted.

---

## 4. TEAMS

### 4.1 Creation
Any user with active intent on the opportunity may create one team (max one per opportunity per user as owner).

Fields: `name` ≤80 chars, `pitch` ≤600 chars, `roles_needed[]`, `max_size`, optional linked `project_id`.

**`max_size` is validated against the opportunity's own `team_size_max` rule.** If the opportunity says teams of 2–5, a team of 6 cannot be created. The eligibility data directly constrains the collaboration feature — the two systems are not independent. `[PR]`

### 4.2 States
| State | Meaning | Transitions |
|---|---|---|
| `forming` | Created, roles not yet declared | → `open_for_roles`, `disbanded` |
| `open_for_roles` | Accepting requests | → `full`, `disbanded` |
| `full` | At `max_size` or owner closed it | → `open_for_roles`, `submitted`, `disbanded` |
| `submitted` | Entered the opportunity | → `archived` |
| `disbanded` | Owner dissolved it | terminal |
| `archived` | Opportunity closed | terminal |

Auto-transitions: reaching `max_size` → `full`; opportunity closing → `archived`; owner inactive for 14 days with pending requests → team marked `stale` in the room and requests expire, so nobody waits on a dead team. `[PR]`

### 4.3 Ownership
Owner may accept/decline requests, edit, remove members, transfer ownership and disband. Members may leave freely. If the owner leaves, ownership transfers to the longest-standing member; if none, the team disbands and requesters are notified.

---

## 5. JOIN REQUESTS

### 5.1 Flow
```
Builder → Request to join (role + message ≤500 chars)
        → Owner sees it in the room and gets a notification
        → Accept  → member added, minimal thread opens, both notified
          Decline → requester notified, no reason required, no re-request for 7 days
          Expire  → auto-expire 72h before the deadline, or after 14 days
```

### 5.2 Rules `[PR]`
- **Rate limits: 10 requests/day, 3/hour, max 5 pending at once.**
- One pending request per team per user.
- **No contact detail is exchanged before acceptance.** Not email, not Telegram, not phone — nothing.
- On acceptance a minimal in-product thread opens. The product then offers handoff to Telegram, WhatsApp or email, requiring **explicit consent from both sides** before any identifier is shared. Most teams will move off-platform immediately, and that is the intended outcome — we are not building a messenger.
- Declines are private. The requester is told the outcome, never who else was accepted.
- Blocking is absolute: a blocked user cannot see, request or be shown the blocker anywhere.

### 5.3 Anti-spam
Copy-paste detection: sending the same message to more than 3 teams within an hour triggers a soft warning and then a 24-hour request cooldown. Bulk identical requests are the dominant spam vector on every platform of this shape.

---

## 6. MATCHING ASSISTANCE

Deliberately weak, deliberately honest. `[PR]`

Inside a room we may show *"These builders offer roles your team still needs"* — computed from declared roles and tag overlap only. That is it.

**We do not:**
- score interpersonal compatibility,
- rank people by quality,
- claim a team will work well together,
- use AI to judge people at all.

Any explanation is factual and templated: *"Offers backend; your team needs backend. Both in Southern Africa. Both tagged Python."*

Rationale: the brief asked for AI team matching with compatibility scores. Scoring humans against each other is the highest-risk, lowest-evidence AI application in the whole product — it invites bias, it cannot be validated, and being wrong about it damages people rather than data. Role complementarity is a fact; compatibility is a guess.

---

## 7. WHOLE-TEAM PARTICIPATION `[FUT]`

Later, a team may link a project, record a submission, and record an outcome (`submitted` / `finalist` / `winner` / `not_selected`) attested by the team owner and confirmed by at least one other member. Two-party attestation is the minimum honest bar for anything that appears on a profile. Unverified single-party claims are never displayed as achievements.

---

## 8. COLD-START PLAYBOOK

The hardest version of the problem: intent is only useful when two people declare it on the **same** opportunity in the same window. With a wide catalogue and few users, collision probability approaches zero.

Mitigations, in order of importance:

1. **Narrow the room-enabled catalogue deliberately.** Team rooms are enabled on a curated subset — roughly 10–20 high-salience opportunities per market per month — not on all 8,000 records. Concentration beats coverage. `[PR]`
2. **Concentrate promotion.** Every Telegram broadcast and country digest pushes the *same* small set, so intent collides.
3. **Anchor to institutions.** A university innovation challenge already has a natural cohort. Partner with GDG on Campus and university chapters so a room fills from an existing group.
4. **Seed honestly or not at all.** No fake users, no fake teams, ever. An empty room is better than a dishonest one. `[PR]`
5. **Let the density floor hide failure.** If a room never fills, no user ever sees an empty room — they see a normal opportunity page.

**Kill criterion `[PR]`:** if, after three months with team rooms live on a curated set, fewer than 15% of rooms reach 3+ intents, the feature is wrong and should be withdrawn rather than redesigned repeatedly. The opportunity product stands alone without it.

---

## 9. WHAT SUCCESS LOOKS LIKE

| Metric | Meaning | Target (6 months post-launch) |
|---|---|---|
| Room fill rate | Rooms reaching ≥3 intents | ≥ 25% of enabled rooms |
| Request acceptance rate | Accepted / sent | ≥ 35% (below this the pool is mismatched) |
| Team completion rate | Teams reaching `full` or `submitted` | ≥ 40% |
| Spam report rate on requests | Reports / 1,000 requests | < 5 |
| Median time to first response | Request sent → decided | < 36 h |

A low acceptance rate means we are letting the wrong requests through. A low fill rate means the catalogue is too wide. Both are diagnosable and both have a named fix.
