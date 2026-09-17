# DESIGN_SYSTEM.md

---

## 1. DESIGN PLAN AND ITS RATIONALE

### 1.1 What this product actually is
A time-critical public information surface for people making decisions under cost pressure. The characteristic objects in its world are **a deadline** and **a verdict** — not a hero image, not a map of Africa, not a dashboard.

The reference is a **public notice board**: information that must be true, current, scannable in seconds, legible in bad light, and cheap to produce. Not a SaaS dashboard, not a social feed, not a magazine.

### 1.2 The one opinionated move
**Colour is reserved for eligibility. Typography carries urgency. Neither borrows the other's channel.**

Most products of this shape use colour for everything and end up with a red deadline next to a red "not eligible" badge, teaching users nothing. Here:

| Signal | Channel | Why |
|---|---|---|
| **Eligibility verdict** | Colour (four-state ramp) | It is categorical, it is the spine of the product, and it deserves the strongest channel |
| **Deadline urgency** | Type size, weight, and pure black | It is continuous, so a continuous channel suits it; and it makes the countdown the single most typographically prominent thing on any card |
| **Freshness** | Monochrome dot and a date | Deliberately quiet — always present, never shouting |
| **Everything else** | Monochrome | If it is not one of the three signals above, it has no colour |

Consequence: a page with no colour on it is a page where nothing is decided yet. Colour appearing means something has been determined about *you*. This also collapses the palette, which serves the byte budget.

### 1.3 Checked against generic defaults
Before locking, this plan was reviewed against the patterns that show up in every generated interface:

| Common default | Used here? |
|---|---|
| Warm cream background, high-contrast serif, terracotta accent | No. Cool off-white, single grotesque, enamel-blue accent. |
| Near-black background with one acid accent | No. Light surface — sunlight legibility on low-end LCD panels. |
| Identical rounded cards with the same soft grey shadow | No. Rows with a status rail; shadow exists only on overlays. |
| Gradients as decoration | None anywhere. Also a byte and rendering cost on low-end devices. |
| All-caps tracked eyebrow labels | No. Sentence case throughout. |
| Meta strings joined with middle dots | No. Facts sit in a labelled grid separated by hairlines. |
| Monospace for small data labels | No. One family; tabular figures handle numeric alignment. |
| "→" appended to button labels | No. Buttons state the action. |
| Numbered 01/02/03 markers | Only where content is genuinely sequential (application steps). |

---

## 2. TYPOGRAPHY

### 2.1 One family
**Archivo Variable** (Omnibus-Type, SIL OFL). Weight 400–700, width 75–100.

Chosen for three reasons specific to this product:
1. **Broad Latin coverage** including Latin Extended-A, which carries French, Portuguese and most African Latin orthographies — necessary for organisation and programme names across 54 countries.
2. **A width axis**, used functionally: metadata rows compress to width 87 on narrow viewports instead of wrapping or truncating. A variable axis earning its bytes rather than decorating.
3. It is a grotesque with visible engineering character, and it is not the default reach.

One file: variable woff2, subset to Latin + Latin Extended-A, **≤ 58 KB**, `font-display: swap`. Fallback stack metric-matched to avoid layout shift:
```css
font-family: Archivo, "Helvetica Neue", Roboto, "Segoe UI", system-ui, sans-serif;
```

`font-variant-numeric: tabular-nums` is **global on all dates, countdowns, counts and prize figures** — columns of deadlines must align.

### 2.2 Scale
Base 16px. Modular, close to a minor third at the top and tightening below, because dense rows need small steps.

| Token | Size / line-height | Weight | Width | Use |
|---|---|---|---|---|
| `display` | 34/38 | 700 | 100 | Page title on detail pages only |
| `title` | 24/30 | 600 | 100 | Section and card titles |
| `subtitle` | 19/26 | 600 | 100 | Sub-sections |
| `body` | 16/26 | 400 | 100 | Prose. Max line length 68ch |
| `body-strong` | 16/26 | 600 | 100 | Emphasis inside prose |
| `dense` | 14/20 | 400 | 100 | List rows, table cells |
| `meta` | 13/18 | 500 | 87 | Fact grids, labels, attribution |
| `micro` | 11/14 | 600 | 87 | Badge text, rail labels |
| `countdown-lg` | 30/32 | 400→700 | 100 | Detail-page countdown |
| `countdown-sm` | 17/20 | 400→700 | 100 | Row countdown |

**The countdown weight is a function of urgency**, interpolated on the variable axis: >30 days → 400, 7 days → 550, ≤48 h → 700. The number physically thickens as the deadline approaches. This is the one piece of expressive typography in the system and it carries real information.

### 2.3 Rules
- Sentence case everywhere. No all-caps except two-letter country codes.
- Never accent a single word of a heading in a different colour or weight.
- No label above content unless the label disambiguates (fact grids qualify; "Description" above a description does not).
- Prose ≤ 68 characters per line.
- No italics for emphasis; use `body-strong`.

---

## 3. COLOUR

### 3.1 Base (monochrome)
| Token | Value | Use |
|---|---|---|
| `--paper` | `#FBFBF9` | Page background |
| `--surface` | `#FFFFFF` | Raised rows, cards, sheets |
| `--sunken` | `#F1F1EE` | Filter bars, table headers, inset panels |
| `--ink` | `#101214` | Body text |
| `--ink-2` | `#4A4F55` | Secondary text, labels |
| `--ink-3` | `#787F87` | Tertiary, placeholders, disabled |
| `--line` | `#E2E2DD` | Hairlines, dividers, input borders |
| `--line-strong` | `#C7C8C2` | Emphasised borders, focused inputs |
| `--absolute` | `#000000` | **Countdown numerals only** |

`--absolute` is used in exactly one place in the entire product. Pure black is the strongest mark available on a low-quality panel in sunlight, and it is spent on the single most decision-relevant number.

### 3.2 Brand
| Token | Value | Use |
|---|---|---|
| `--brand` | `#17316F` | Primary buttons, links, focus rings, logotype, heavy informational blocks |
| `--brand-ink` | `#0E2350` | Hover/active |
| `--brand-wash` | `#EAEFF9` | Selected filter chips, brand-tinted surfaces, context strips |

A deep enamel navy, taken from painted institutional signage rather than software convention. 12.3:1 on white and 11.9:1 on paper, and clearly separate from every status hue.

Deepened from `#1C3F94` in the mobile pass, for a reason that is about surfaces rather than about taste. `--brand` now paints **heavy informational blocks** as well as controls — the numbers band on the board was `--ink`, the near-black reserved for type, which made the loudest strip on the page the one part of it that belonged to no brand. A full-bleed band wants a colour with no electric cast to it at that size, and it wants headroom for secondary text laid over it: white at 70% measures 6.44:1 on the navy against 5.02:1 on the old blue.

### 3.3 Eligibility ramp — the only semantic colour
| Verdict | Ink | Wash | Rail |
|---|---|---|---|
| `eligible` | `#0B6B33` | `#E7F2EA` | 3px `#0B6B33` |
| `likely_eligible` | `#5A6E13` | `#F0F2E3` | 3px `#5A6E13` |
| `unclear` | `#8A5A0B` | `#F7F0E2` | 3px `#8A5A0B` |
| `not_eligible` | `#8E2B2B` | `#F7EAEA` | 3px `#8E2B2B` |
| `unknown` (no profile) | `--ink-3` | `--sunken` | 3px `--line-strong` |

Green and olive are deliberately far apart in hue and lightness — `eligible` and `likely_eligible` must never be confusable at a glance or by a colour-blind user.

**Colour is never the only carrier.** Every verdict also has a distinct glyph (● filled circle, ◐ half circle, ？, ✕, ○) and a text label. Removing colour entirely leaves the interface fully usable. `[PR]`

### 3.4 Feedback (system messages only, never on data)
`--danger #8E2B2B` · `--warning #8A5A0B` · `--success #0B6B33` · `--info --brand`.
These appear in toasts, form errors and banners. They never colour an opportunity row.

### 3.5 Contrast `[PR]`
Every text/background pair meets WCAG AA (4.5:1 body, 3:1 large). Verified pairs: ink/paper 16.8:1, ink-2/paper 7.9:1, ink-3/paper 4.6:1, brand/paper 7.4:1, eligible/wash 6.1:1, unclear/wash 5.2:1, not-eligible/wash 6.4:1. Any new pair must be checked in CI.

---

## 4. SPACE, GRID, SHAPE

### 4.1 Spacing
4px base: `2 4 6 8 12 16 20 24 32 40 56 72`. Nothing outside the scale.

### 4.2 Grid
| Breakpoint | Width | Columns | Gutter | Margin |
|---|---|---|---|---|
| `xs` ≤ 380 | fluid | 1 | — | 12 |
| `sm` 381–599 | fluid | 1 | — | 16 |
| `md` 600–899 | fluid | 6 | 16 | 24 |
| `lg` 900–1199 | 1040 max | 12 | 20 | 32 |
| `xl` ≥ 1200 | 1160 max | 12 | 24 | auto |

Content is left-aligned throughout. Nothing is centred except empty-state blocks and modal chrome — centred text is harder to scan and this product is scanned.

### 4.3 Radius and elevation
Radius: `0` (hairlines, rails), `1rem` (everything with a boundary — cards, panels, sheets, modals, inputs, buttons, chips), `999px` (pills and the avatar monogram only).

**One radius, not a family.** The scale was 4px controls inside 8px sheets, then 10px inside 18px; either way a button never quite belonged to the card holding it, and on a phone — where the card IS the screen width and the button sits flush inside it — the two arcs meet at the same corner and the mismatch is the first thing the eye finds. `1rem` is Tailwind's own `rounded-2xl`, so `rounded-row`, `rounded-sheet` and `rounded-2xl` are one shape.

The token NAMES survive the merge (`--radius-row`, `--radius-sheet`), because they say what a thing is — a control or a surface — and every call site already speaks in them. Changing the value in `tokens.css` is what changes the product.

**Elevation exists only where something floats above the page**: bottom sheets, modals, dropdowns, toasts. A single shadow token, `0 8px 24px rgba(16,18,20,0.14)`. Rows and cards are separated by hairlines, never by shadow — shadows on a list of 40 rows are visual noise and a rendering cost on low-end GPUs.

---

## 5. COMPONENTS

### 5.1 Opportunity row — the primary object
```
┌─┬──────────────────────────────────────────────┐
│ │ AgriTech AI Challenge 2026                   │
│█│ Kumasi Hive · verified                       │
│ │ ┌─────────┬─────────┬─────────┬────────────┐ │
│ │ │ Closes  │ Format  │ Team    │ Prize      │ │
│ │ │ 5 days  │ Remote  │ 2–5     │ $10,000    │ │
│ │ └─────────┴─────────┴─────────┴────────────┘ │
│ │ ● Eligible          Checked 11 Sep    [Save] │
└─┴──────────────────────────────────────────────┘
```
- **Status rail** (left, 3px, full height): the eligibility colour. The only colour in the row.
- **Countdown**: black, tabular, weight by urgency.
- **Fact grid**: labelled cells separated by hairlines — not a middle-dot string. Labels in `micro`, values in `dense`. Collapses to two columns below 380px, never wraps mid-fact.
- **Freshness**: monochrome, always present, `meta`.
- Whole row is the link; `[Save]` is a nested button with its own hit area.
- Row height ≥ 88px so the tap target is generous.
- No image, no logo, no shadow, no hover lift. Hover changes background to `--sunken` only.

### 5.2 Verdict block (opportunity detail)
Full-width panel in the verdict wash with the verdict ink. Verdict label and glyph, then one line per rule: glyph, plain-language outcome, and the **quoted source sentence** in `meta`, indented with a hairline left border. Below: missing-field prompts as inline actions, then the permanent disclaimer and a link to the official page.

This block is the product's core moment. It gets the most vertical space above the fold on the detail page.

### 5.3 Buttons
| Variant | Fill | Text | Use |
|---|---|---|---|
| `primary` | `--brand` | `#FFF` | One per view |
| `secondary` | `--surface`, 1px `--line-strong` | `--ink` | Common actions |
| `quiet` | none | `--brand` | Tertiary |
| `danger` | `--surface`, 1px `--danger` | `--danger` | Destructive |

Height 44px (48px on touch), radius 4, `body-strong`. Labels are verbs naming the result: "Save opportunity", "Request to join", "Publish". The label persists through the flow — a button that says "Publish" produces a toast that says "Published". No arrows, no icons unless the icon *is* the button.

### 5.4 Filter chips
Rounded 4px, `--sunken` unselected / `--brand-wash` with `--brand` text and 1px `--brand` selected. Each carries a dismiss target. A "Clear all" quiet button appears when ≥1 is active. On mobile, filters live in a bottom sheet; active chips remain visible in a horizontally scrolling strip below the search field.

NL-compiled chips render identically to manually chosen ones, with one difference: a small "from your search" label above the strip, so the user knows what was interpreted and can correct it.

### 5.5 Badges
`micro`, 2px radius, 2/6 padding.
- **Verification**: `verified` (ink-2 on sunken, ✓), `official` (brand on brand-wash, ✓), `auto` (ink-3 on sunken, no glyph — machine-extracted is stated plainly), `stale` (ochre, ◔), `disputed` (oxblood, ⚠), `expired` (ink-3, strikethrough).
- **Deadline**: text only, no badge. Urgency is typographic.

### 5.6 Fact grid
The general pattern for structured facts (opportunity facts, team details, organisation details). Labels `micro` `--ink-2`, values `dense` `--ink`, hairline separators, 2 columns at `xs`, 4 at `md`+. Never a definition list of prose.

### 5.7 Navigation
**Mobile** — top bar, 56px: wordmark left, and search / account / menu as icon targets right. The five destinations live in a disclosure menu opened from the menu target: Board · Search · Categories · Countries · Saved, with the account surfaces — including **Your eligibility details** — beneath them.

**Desktop** — top bar, 56px, logotype left, primary nav centre-left, search centre, account right. No mega-menu.

**Never**: sticky promotional banners; cookie walls (see `PRIVACY_AND_COMPLIANCE.md` — no non-essential cookies are set, so no banner is needed).

#### Amended 2026-09-16 — the bottom bar, and the hamburger that was banned

This section previously specified a five-item bottom bar on mobile and ended "**Never**:
hamburger menu hiding primary navigation". The bar was built to that specification, and
the operator then asked twice for it to go. `design/NavChoice.dc.html` drew both options
with their costs and said the choice was theirs; they chose the menu. The ban is lifted
here rather than contradicted in code, because a specification the implementation
quietly ignores is worse than one that records why it changed.

What the ban was protecting, and what is done about it:

- **First-time discovery.** §5.7's reason for banning the hamburger was that this
  product's readers mostly arrive once, from a link, and a destination behind a tap is a
  destination they never find. Mitigated, not solved: the four paths that matter most —
  the category chips — are on the board itself, and search has its own icon target
  rather than living in the menu.
- **Vertical space**, which is what the bar cost and why it went. 56px of a 844px phone
  on every screen, permanently.

The menu is a `<details>` disclosure, not a scripted sheet: the CSP carries no
`'unsafe-inline'` (ADR 0002), and a navigation that needs JavaScript to open is a
navigation that fails on the connections §10 exists for. It therefore has no `Esc`
handler, no backdrop and no focus trap, which §5.8 would require of a modal — it is a
disclosure and not a modal, and it works with JavaScript switched off entirely.

### 5.8 Sheets, modals, toasts
- **Bottom sheet** (mobile default for filters, actions, forms): rounded 8px top, drag handle, `Esc` and backdrop dismiss, focus trapped, scroll locked behind.
- **Modal** (desktop): 8px radius, max 560px, same focus behaviour.
- **Toast**: bottom-centre above the nav bar, 4s, `role="status"`, one at a time, dismissible. Never used for errors that need a decision.

### 5.9 Tables
Only in admin. Sticky header, zebra via `--paper`/`--surface`, right-aligned numerics with tabular figures, horizontal scroll with the first column pinned. Never used on public mobile pages — fact grids and rows replace them.

### 5.10 Forms
Label above input, always visible (never placeholder-as-label). Input 44px, 1px `--line`, radius 4, `--line-strong` on focus plus a 2px `--brand` outline offset 2px. Help text below in `meta`. Errors below in `--danger` with an icon, and `aria-describedby` wired. Required fields marked on the label, optional fields unmarked — most fields here are optional, so marking required is the shorter list.

Eligibility-profile fields each carry a one-line explanation of what it unlocks: *"Your year of study resolves eligibility on 23 opportunities."*

---

## 6. STATE VOCABULARY

Every state below has a defined visual treatment and copy. Copy rules: explain what happened and what to do; never apologise; never use "Oops"; never blame the user.

### 6.1 Opportunity states
| State | Treatment |
|---|---|
| Open | Normal row |
| Closing today | Countdown weight 700, single ochre dot before it |
| Closed / expired | Row at 60% opacity, countdown struck through, "Closed" badge, save disabled |
| Disputed | Oxblood banner above the row: "Someone reported a problem with this. We're checking." |
| Stale | Ochre freshness dot, "Last checked 24 days ago" in `meta` |
| Merged | Detail page shows a notice and a link to the canonical record. Never a silent redirect. |

### 6.2 Team and project states
Rendered as text labels in `micro` with a hollow/filled dot, no colour: `forming ○`, `open for roles ◐`, `full ●`, `submitted ●`, `disbanded ○`. Project states likewise.

### 6.3 Loading
- **Never a spinner on a full page.** Server-rendered HTML arrives with content.
- **Skeletons only for the eligibility block and the recommendation list** — the two genuinely asynchronous regions. Skeletons match final dimensions exactly to prevent layout shift.
- **Inline pending**: buttons show a 16px inline indicator and disable, keeping their label.
- **Offline queued writes**: a persistent `meta` line, "Saved on this device, will sync", with a manual retry.

### 6.4 Empty states
An empty screen is an invitation to act — one sentence naming the situation, one action. Never an illustration (bytes), never a mascot, never "Nothing here yet!".

| Context | Copy | Action |
|---|---|---|
| No search results | "No open opportunities match these filters." | "Clear filters" · "Search all of Africa" |
| Country with few listings | "We're still building coverage for Malawi. 3 open now." | "See Africa-wide opportunities" · "Suggest a source" |
| Empty tracker | "Nothing saved yet. Saving an opportunity gets you a reminder before it closes." | "Browse what's closing this week" |
| Room below density floor | "No one has said they're going for this yet." | "Say you're going" |
| No recommendations | "Add your country and student status and we'll check eligibility for you." | "Complete your profile" |
| Offline, nothing cached | "You're offline. Opportunities you've opened before are still available." | "See saved" |

### 6.5 Errors
| Situation | Copy |
|---|---|
| 404 | "That opportunity isn't here. It may have been merged or removed." + search |
| 410 merged | "This moved. It's now listed as [title]." |
| 429 | "You've sent a lot of requests. Try again in 12 minutes." |
| 503 degraded search | Silent — results render with a `meta` note: "Searching by keyword right now." |
| Form validation | Inline, at the field, naming the fix |
| Failed write, offline | "Not sent — you're offline. We'll retry when you're back." |

### 6.6 Success
Toast with the past tense of the button that caused it. Tracker changes animate only the changed row's status rail, 120ms. Nothing else moves.

---

## 7. MOTION

Minimal and functional. `[PR]`

| Element | Duration | Easing |
|---|---|---|
| Sheet in/out | 220ms / 160ms | `cubic-bezier(.2,.8,.2,1)` |
| Toast | 180ms | ease-out |
| Chip add/remove | 120ms | ease-out |
| Status rail change | 120ms | linear |
| Nav bar hide/show | 160ms | ease |

No entrance animations on page load. No hover lifts. No scroll-triggered reveals. **`prefers-reduced-motion: reduce` removes all of the above**, leaving instant state changes. `[PR]`

---

## 8. ACCESSIBILITY `[PR]`

Target: **WCAG 2.1 AA**, verified in CI with axe on every public route.

- Semantic HTML first: `<main>`, `<nav>`, `<article>` per opportunity, `<time datetime>` on every date, real `<button>` and `<a>`.
- Keyboard: every interactive element reachable, logical order, visible focus (2px `--brand`, offset 2px, never removed), focus trapped in overlays and restored on close, skip-to-content link.
- Screen readers: verdicts announced as text ("Likely eligible. Three of four requirements met. One needs your birth year."), countdowns as text ("Closes in 5 days, 30 September 2026"), `aria-live="polite"` on results count and toasts, `aria-live="assertive"` reserved for errors.
- Colour independence: every colour-coded state has a glyph and a label.
- Touch targets ≥ 44×44px with ≥ 8px separation.
- Zoom to 200% without horizontal scroll or clipping.
- Forms: label association, `aria-describedby` for help and errors, `autocomplete` on identity fields, error summary at the top of long forms linking to fields.
- Language: `lang` on `<html>`, and `lang` on any element in another language (organisation names, programme titles).
- No content conveyed by icon alone.

---

## 9. RESPONSIVE BEHAVIOUR

| Component | xs ≤380 | sm 381–599 | md 600–899 | lg 900+ |
|---|---|---|---|---|
| Opportunity row | Stacked, 2-col fact grid, width 87 metadata | Stacked, 2-col | Single line title, 4-col grid | Same + inline save |
| Filters | Bottom sheet + chip strip | Bottom sheet + chips | Collapsible bar | Persistent left rail, 240px |
| Detail page | Single column; verdict above description | Single column | Single column, 640px | Two column: content 8 / sticky facts+verdict 4 |
| Navigation | Bottom bar | Bottom bar | Bottom bar | Top bar |
| Search | Full-width field, sheet for filters | Same | Field + inline sort | Field + filters + sort inline |
| Team room | Stacked sections | Stacked | Stacked | Two column: teams / solo builders |
| Admin queue | One card, swipe between | One card | Card + list | List + detail pane |
| Tables (admin) | Horizontal scroll, first column pinned | Same | Same | Full |

**Mobile is designed first and independently**, not derived by shrinking the desktop layout. The bottom sheet pattern, the 2-column fact grid and the width-axis compression exist only on mobile and have no desktop equivalent.

---

## 10. LOW-DATA MODE

Triggered by the user toggle or a `Save-Data: on` header, read server-side so the first paint is already light. `[PR]`

- All images suppressed, including organisation logos — replaced by a two-letter monogram in `--sunken` with `--ink-2` text, rendered in CSS.
- No prefetch, no speculative loading.
- Lists render dense; fact grids collapse to the two most important facts (countdown, eligibility).
- Font falls back to the system stack; the webfont is not requested.
- A persistent `meta` line in the footer: "Low-data mode is on." with a toggle.

Target: an opportunity list page under **40 KB** in low-data mode. At Zimbabwe's mobile data prices this is roughly a tenth of a US cent per page, versus about nine cents for a typical 2 MB web app — the difference between a product people can afford to browse and one they cannot.

---

## 11. LOGOTYPE AND BRAND EXPRESSION

Wordmark only: the brand name in Archivo 700, width 100, letter-spacing `-0.015em`, `--brand`. No symbol, no icon mark, no illustration at launch — a symbol costs bytes and design debt and earns nothing until the name is settled and trademark-cleared.

Brand expression lives in **restraint and accuracy**, not ornament: the status rail, the black countdown, the visible freshness date, the quoted source sentence. Those four marks are the identity. If the product is memorable it will be because it told people the truth quickly, and the interface should look like that is what it does.

---

## 12. IMPLEMENTATION NOTES

- Tailwind with these tokens defined in `tailwind.config` as the *only* permitted values. Arbitrary values (`[13px]`, `[#ff0000]`) fail lint. `[PR]`
- Tokens are also emitted as CSS custom properties on `:root` for use outside Tailwind (email templates, the Telegram bot's link previews, admin).
- No runtime CSS-in-JS. No component library shipped to the client.
- Dark mode: **not in Phase 1.** Deferred deliberately — it doubles contrast verification work and the primary use context (daylight, low-end LCD) favours a light surface. Tokens are structured so a dark theme is a token swap, not a rewrite. `[FUT]`
- Icons: inline SVG sprite, stroke 1.5, 20×20 and 24×24 only, ≤ 4 KB total, no icon font ever.
