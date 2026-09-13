# NOTIFICATIONS.md

**The core tension:** notifications are the retention mechanism, and the free email tier caps them at ~300/day shared with authentication. The system must therefore be **budgeted, prioritised and channel-aware** from the first line of code, not made "efficient" later.

**The resolution:** Telegram carries the load. Email is a scarce, prioritised resource. In-app is always available and costs nothing.

---

## 1. PRINCIPLES `[PR]`

1. **Every message states why it was sent.** A `reason` string is a required field on every notification, rendered in the message.
2. **Hard caps, enforced before enqueue:** at most **1 digest/day** and **3 non-request transactional messages/day** per user. Direct request and acceptance events are exempt because they are person-to-person and time-sensitive.
3. **No engagement bait.** No "you have 3 unread", no re-engagement nudges, no streaks, no "people are looking at your profile", no notifications about other people's activity you did not ask about.
4. **One-tap unsubscribe per type**, working without a session, from every message.
5. **Quiet hours** in the user's timezone, default 21:00–07:00, never overridden except for a deadline within 6 hours on a tracked item.
6. **Silence is acceptable.** A day with nothing worth saying produces no message. The digest is skipped, not padded.

---

## 2. CHANNELS

| Channel | Cost | Capacity | Role |
|---|---|---|---|
| **In-app** | $0 | Unlimited | Always written. The system of record. |
| **Telegram** | $0 | **Unmetered** | **Primary push.** |
| **Email** | $0 up to ~300/day | **280/day budget** | Secondary, prioritised. |
| **Web push** | $0 | Unlimited | `[OPT]` — low install rates on low-end Android; not Phase 1. |
| **RSS** | $0 | Unlimited | Pull, not push. Country/category feeds. |
| **SMS / WhatsApp** | Not free | — | **Not used.** Stated as a known gap. |

**Every notification is always written in-app**, regardless of whether any push channel delivers it. A user who never links Telegram and whose email is deferred still sees everything when they open the app. Nothing is lost, only delayed. `[PR]`

---

## 3. TYPES

| Type | Priority | Default channels | Cap-exempt |
|---|---|---|---|
| `security` (new sign-in, email change) | 1 | Email + in-app | Yes |
| `deadline_reminder` ≤48h, tracked | 2 | Telegram + email + in-app | Yes |
| `deadline_reminder` 7d / 3d, tracked | 3 | Telegram + in-app | No |
| `request_received` | 2 | Telegram + in-app | Yes |
| `request_accepted` / `declined` | 2 | Telegram + in-app | Yes |
| `opportunity_changed` (deadline, eligibility, cost, apply URL) | 2 | Telegram + in-app | Yes |
| `opportunity_closed` (tracked) | 3 | Telegram + in-app | No |
| `team_update` (member joined/left, team disbanded) | 4 | In-app | No |
| `project_match` (new matches) | 4 | Digest only | No |
| `digest` | 5 | Telegram or email, one channel | No |
| `moderation_outcome` | 3 | In-app + email | Yes |
| `system` | 5 | In-app | No |

**Deliberately absent:** anything about other people's activity that the user is not party to, anything about platform milestones, anything designed to pull the user back without new information.

---

## 4. THE EMAIL BUDGET QUEUE `[PR]`

```
Daily budget: 280   (300 Brevo limit − 20 reserved for auth OTP)

Dispatcher runs every 15 minutes:
  1. Read today's send_budget for 'email'
  2. Select queued deliveries ORDER BY priority ASC, scheduled_for ASC
  3. For each:
       priority 1–2  → send (always; if budget exhausted, borrow from
                       tomorrow and alert the operator)
       priority 3    → send if remaining > 40
       priority 4–5  → send if remaining > 120
       otherwise     → defer 24h, max 2 deferrals, then downgrade
                       to in-app only and mark 'suppressed'
  4. Increment send_budget
  5. If budget exhausted before 18:00 on two consecutive days
       → Telegram alert to the operator
```

**Downgrade is visible, not silent:** a suppressed digest leaves an in-app notification reading *"Your digest is waiting — link Telegram to get it delivered."* This converts a capacity limit into the exact nudge that fixes it.

**Arithmetic to internalise:** 280 emails/day supports roughly 280 daily digest recipients. At 500 active users wanting daily digests, email alone cannot serve them. **Telegram adoption is not a nice-to-have; it is the scaling plan.** Telegram linking is therefore offered at the moment of highest intent — immediately after a user's first save — rather than buried in settings.

---

## 5. THE DIGEST

### 5.1 Composition
Assembled by the nightly `digest` job, delivered per timezone bucket at 06:00 local.

```
Content, in fixed order, hard-capped:
  1. Closing in ≤3 days from your tracker        (max 3)
  2. New, eligible, closing ≤30 days              (max 4)
  3. New matches for your projects                (max 2)
  4. Pending requests awaiting your decision      (max 1 line)
Total: never more than 8 items.
```

**Suppression rules `[PR]`:**
- Fewer than 2 items → not sent at all. A thin digest teaches people to ignore digests.
- Nothing new since the last digest → not sent.
- User opened the app within the last 12 hours → downgrade daily to weekly automatically (they are already engaged; a digest is redundant).

### 5.2 Format
Plain text first. The HTML version is ≤ 15 KB with no images, no tracking pixel, no web fonts, and a single link colour. It must be fully legible as plain text because many recipients read mail on constrained clients.

```
{Brand} — 12 September

CLOSING SOON (from your tracker)
• AgriTech AI Challenge — closes in 2 days — you're eligible
  https://…
• Mastercard Scholars — closes in 6 days — needs your year of study
  https://…

NEW, OPEN TO ZIMBABWE
• Deep Learning Indaba travel grant — closes 30 Sep — likely eligible
  https://…

You're getting this because you saved 2 opportunities and asked for
daily updates.
Change frequency: …   Stop these: …
```

No subject-line urgency tricks. Subject is factual: *"2 closing this week, 3 new for Zimbabwe"*.

### 5.3 Frequency
Daily, weekly (default), or off. **Weekly is the default** because it is more sustainable for both the user and the budget, and because a weekly digest that is always worth reading beats a daily one that is sometimes padded.

---

## 6. DEADLINE REMINDERS

Driven by tracker state, not by browsing.

| Tracker state | Reminders |
|---|---|
| `saved` | 7 days, 2 days before |
| `planning_to_apply` | 7, 3, 1 days before |
| `applied` / `submitted` | Start date only |
| `participating` | Event start, submission deadline |
| Terminal states | None |

Users may set one custom reminder per tracked item. A reminder for an opportunity that has since expired or been rejected is **cancelled, not sent** — the job re-checks state at send time, not at schedule time. `[PR]`

---

## 7. TELEGRAM DELIVERY

Push messages are short, plain, and always carry a reason and an exit:

```
Closing in 2 days: AgriTech AI Challenge 2026
You're eligible. Teams of 2–5. Free to enter.
→ {link}

You saved this on 3 September.  /pause  /stop
```

Rules: ≤3 inline buttons, no images, no media, no message groups. `/pause` suspends pushes for 30 days without unlinking. `/stop` unlinks completely and is honoured immediately. Delivery failures (user blocked the bot) mark the channel inactive after 3 consecutive failures and fall back to email or in-app. `[PR]`

---

## 8. PREFERENCES UI

A type × channel matrix at `/you/notifications`, with plain-language rows ("When something I saved is about to close") rather than system type names.

The caps are **stated visibly** on the page: *"We send at most one digest a day and three other messages. We never send anything to get your attention back."* Stating the limit is itself a trust signal, and it sets an expectation the system is architecturally obliged to keep.

Also present: quiet hours, timezone, digest frequency, Telegram link/unlink, and a "pause everything for 30 days" control.

---

## 9. UNSUBSCRIBE

- Every email carries `List-Unsubscribe` and `List-Unsubscribe-Post` headers for one-click unsubscribe in the mail client.
- The in-message link works **without a session**, via a signed token, and unsubscribes from **that type only** — never from everything, and never silently from security messages.
- The unsubscribe confirmation page offers "reduce frequency instead" as an equal-weight option.
- Unsubscribing is honoured immediately and is never followed by a "are you sure?" email.

---

## 10. FAILURE HANDLING

| Failure | Behaviour |
|---|---|
| Brevo unavailable | Deliveries stay queued; retry with backoff; Telegram and in-app unaffected |
| Telegram API error | Retry 3×, then mark delivery failed; fall back to email if budget allows |
| User blocked the bot | 3 consecutive failures → channel inactive, in-app notice on next visit |
| Budget exhausted | Priority 4–5 defer; priority 1–2 borrow from tomorrow and alert |
| Digest job fails | No message sent; alert; **never send a stale digest the next day** — regenerate fresh |

**Invariant:** a notification failure never loses information, because the in-app record is always written first. `[PR]`

---

## 11. MEASUREMENT

| Metric | Target | Meaning if breached |
|---|---|---|
| Digest open rate | ≥ 35% | Content is not worth reading |
| Digest → click rate | ≥ 12% | Items are not relevant |
| Unsubscribe rate | < 2%/month | Too frequent or too noisy |
| Telegram adoption among active users | ≥ 40% by month 6 | Email budget will bind; push the link prompt harder |
| Deadline reminders sent before an expiry | ≥ 95% | The core promise is failing |
| Suppressed (budget-downgraded) digests | < 5% | Migrate to Telegram or accept the cost |

The last two are the ones that matter. Reminding someone before a deadline is the product's most concrete promise; if that number slips, nothing else on this list is worth measuring.
