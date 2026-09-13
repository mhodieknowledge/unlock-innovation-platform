# SEO.md

**Strategic position:** incumbent aggregators (Opportunity Desk, Opportunities for Africans, After School Africa, Scholarship Region) have years of domain authority and enormous publication volume. **We will not win on volume.** We win on *specificity and structure* — queries they answer badly.

**The target query shape:** "AI hackathons open to Zimbabwe", "grants for Zambian students 2026", "remote fellowships for Malawians". These are long-tail, intent-heavy, country-specific — and they map exactly to pages the data model already generates.

---

## 1. PAGE ARCHITECTURE AND INDEXING

| Route | Indexed | Priority | Changefreq |
|---|---|---|---|
| `/` | Yes | 1.0 | Hourly |
| `/opportunities/[slug]` (published) | **Yes — primary** | 0.9 | Daily |
| `/opportunities/[slug]` (expired) | **No** (`noindex, follow`) | — | — |
| `/countries/[slug]` | **Yes — primary** | 0.9 | Daily |
| `/countries/[slug]/[category]` | **Yes — the long tail** | 0.8 | Daily |
| `/categories/[slug]` | Yes | 0.7 | Daily |
| `/organisations/[slug]` | Yes | 0.7 | Weekly |
| `/b/[handle]` | Only if `indexable=true` (default off) | 0.3 | Weekly |
| `/projects/[slug]` | Only if public **and** `indexable=true` (default off) | 0.4 | Weekly |
| `/opportunities?filters…` | **No** (`noindex, follow`) | — | — |
| `/dashboard`, `/tracker`, `/you`, `/rooms`, `/threads`, `/admin` | **No** (`noindex, nofollow`) | — | — |
| Policy pages, `/bot` | Yes | 0.3 | Monthly |

**Rules `[PR]`:**
- Filtered and paginated search URLs are `noindex, follow` — they are user tools, not content, and indexing them creates thin-content duplication at scale.
- Private surfaces are `noindex, nofollow` **and** blocked in `robots.txt` **and** unreachable without a session. Three layers, because one will eventually be misconfigured.
- Profiles and projects are never indexed without an explicit per-object opt-in. A user who fills in a profile has not consented to being findable on Google.

---

## 2. THE COUNTRY × CATEGORY MATRIX — the growth engine

54 countries × ~21 categories generates a large surface, but **most cells are empty and an empty cell is worse than no page.**

**Generation rule `[PR]`:** a `/countries/[slug]/[category]` page is generated and indexed only when it holds **≥ 5 currently-open opportunities**. Below that, the route 301-redirects to `/countries/[slug]`. This prevents thin-content penalties and, more importantly, prevents a human arriving at a page with nothing on it.

Country pages themselves are generated for all 54 regardless, because Africa-wide and global opportunities give every country real content. A country page showing "3 open to Malawi, plus 180 Africa-wide" is honest and useful.

**This is also why country pages are the primary sharing unit** — a GDG lead forwarding `/countries/zimbabwe` to a WhatsApp group is both the growth loop and the SEO signal.

---

## 3. STRUCTURED DATA

Server-rendered JSON-LD on every public page. No client-side injection.

**Opportunity pages** — type chosen by category:
| Category group | Schema type |
|---|---|
| Hackathon, competition, challenge | `Event` + `EventAttendanceMode` |
| Scholarship, fellowship, grant | `EducationalOccupationalProgram` |
| Internship, developer programme | `JobPosting` (with `employmentType: INTERN`) |
| Accelerator, incubator, bootcamp | `EducationalOccupationalProgram` |

```jsonc
{
  "@context": "https://schema.org",
  "@type": "Event",
  "name": "AgriTech AI Challenge 2026",
  "startDate": "2026-10-15",
  "endDate": "2026-10-17",
  "eventAttendanceMode": "https://schema.org/OnlineEventAttendanceMode",
  "eventStatus": "https://schema.org/EventScheduled",
  "location": { "@type": "VirtualLocation", "url": "https://…" },
  "organizer": { "@type": "Organization", "name": "Kumasi Hive", "url": "https://…" },
  "description": "…",               // our summary, never the source's prose
  "url": "https://{domain}/opportunities/agritech-ai-challenge-2026",
  "isAccessibleForFree": true,
  "inLanguage": "en",
  "eligibleRegion": [ { "@type": "Country", "name": "Zimbabwe" }, … ]
}
```

Also emitted: `BreadcrumbList` on every page, `Organization` on organisation pages, `ItemList` on country and category pages, `WebSite` with `SearchAction` on the homepage, `FAQPage` on the anti-scam and verification explainers.

**Rules `[PR]`:**
- `description` is **our** summary, never copied source prose (also a copyright requirement — see `OPPORTUNITY_INGESTION.md` §2.1).
- Expired opportunities set `eventStatus: EventCancelled` or are dropped from structured data entirely rather than misrepresented as open.
- **Never mark up a fact we have not verified.** If `deadline_precision` is `month_only`, no exact `endDate` is emitted.
- No review, rating or aggregate-rating markup anywhere — we do not rate opportunities and will not fake signals for rich results.

---

## 4. METADATA

**Titles** (≤60 chars), templated and specific:
| Page | Pattern |
|---|---|
| Opportunity | `{title} — {organisation} \| Closes {date}` |
| Country | `Opportunities open to {country} ({n} open now)` |
| Country × category | `{Category} for {demonym} — {n} open now` |
| Organisation | `{name} — opportunities and programmes` |

**Descriptions** (≤155 chars) are generated from real fields, never boilerplate:
> "Open to builders in Zimbabwe. Teams of 2–5. $10,000 prize. Applications close 30 September 2026. Free to enter."

**Open Graph and Twitter cards:** `og:title`, `og:description`, `og:url`, `og:type=article`, `og:site_name`, `twitter:card=summary`.

**The social image decision `[PR]`:** a dynamically generated OG image would be ideal, but image generation at request time costs Worker CPU (10 ms limit) and every card view costs bandwidth. Instead: a **single static 1200×630 brand card** (≤ 25 KB, generated once at build) is used site-wide, and `twitter:card` is `summary` rather than `summary_large_image` so the preview stays small. The title and description carry the specificity. This trades a marginal click-through gain for a real, repeated bandwidth saving, which is the correct trade for this audience. Revisit only if measurement shows it costs meaningful reach. `[OPT]`

---

## 5. TECHNICAL SEO

**Canonicals:** self-referencing on every indexable page. Filtered views canonicalise to the unfiltered base. Merged opportunities return `410 GONE` with a link, not a redirect — a merged record is not the same content, and a silent 301 would mislead a reader who followed a shared link.

**Sitemaps**, regenerated nightly, segmented so each stays under 50,000 URLs:
`/sitemap.xml` (index) → `/sitemaps/opportunities.xml`, `/sitemaps/countries.xml`, `/sitemaps/categories.xml`, `/sitemaps/organisations.xml`, `/sitemaps/public-profiles.xml`, `/sitemaps/static.xml`. `lastmod` reflects real modification time. Expired opportunities are removed from sitemaps on expiry.

**robots.txt:**
```
User-agent: *
Allow: /
Disallow: /dashboard
Disallow: /tracker
Disallow: /you
Disallow: /rooms
Disallow: /threads
Disallow: /requests
Disallow: /admin
Disallow: /api/
Disallow: /*?          # filtered views
Sitemap: https://{domain}/sitemap.xml
```

**URLs:** lowercase, hyphenated, stable, no dates in opportunity slugs unless the title contains a year, no IDs. A slug never changes after publication; a title correction keeps the original slug.

**Internal linking:** every opportunity links to its country, category and organisation pages. Country pages cross-link to neighbouring countries and to Africa-wide. Related opportunities are computed, not hand-curated. This creates a dense, crawlable graph without any link-building effort.

**Performance as an SEO factor:** the byte budgets in `PRODUCT_SPEC.md` §25.1 produce Core Web Vitals far better than any incumbent's ad-laden pages. LCP under 1.2s on 3G is realistic for a 120 KB server-rendered page. Targets: LCP ≤ 2.0s, INP ≤ 150ms, CLS ≤ 0.05, measured at the 75th percentile on a simulated slow 3G, mid-tier Android profile — **not on a developer laptop**.

---

## 6. CONTENT QUALITY AND DUPLICATION

The single biggest SEO risk for an aggregator is being classified as thin, duplicative content.

**Mitigations `[PR]`:**
1. **Never reproduce source prose.** Summaries are original and validated by an 8-consecutive-word overlap check against the source (also a copyright control).
2. **Add what the source lacks** — structured eligibility with quoted rules, a verdict tool, a decoded brief, freshness dates, related opportunities, country context. These make our page genuinely more useful than the original, which is the only durable justification for it ranking.
3. **Always link to the official source**, prominently and early.
4. Do not publish a page with nothing but a title and a link. Below a minimum-content threshold, a record is listed in indexes but its detail page is `noindex` until enriched.
5. No doorway pages, no programmatic city-level pages, no keyword-stuffed variants.

---

## 7. NON-SEARCH DISCOVERY

Search engines are one channel and, given where this audience actually lives, not the most important one.

- **RSS feeds** per country, category, organisation and closing-soon. Free, zero-JS, machine-readable, and directly consumable by Telegram channel bots — which means our feed can propagate through the ecosystem's existing distribution rather than competing with it. `[PR]`
- **Telegram bot** as a first-class client (`UX_FLOWS.md` §15).
- **Country pages as the shareable unit** — a single URL a community leader can forward to a WhatsApp group, which renders fast and cheap on the recipient's phone.
- **Embeddable widget** `[FUT]` — a lightweight iframe a university or GDG chapter can drop on its own page showing opportunities open to its country. Distribution through institutions, not algorithms.
- **Organisation pages as a partnership surface** — an organisation that claims its page has a reason to link to it.

---

## 8. MEASUREMENT

| Metric | Why |
|---|---|
| Indexed pages by type | Detects the thin-content redirect rule misfiring |
| Impressions and clicks for country × category queries | The specific thesis being tested |
| Share of entries landing on an opportunity page | Deep entry is the intended pattern |
| Search → eligibility-check conversion | Whether search traffic reaches the core value |
| RSS subscriber count and Telegram links | Non-search distribution health |
| Core Web Vitals at p75 on mobile | Byte-budget compliance in the field |

Google Search Console and Bing Webmaster Tools only. No third-party SEO scripts — they would breach the byte budget, which is the same rule that produces the good vitals in the first place.
