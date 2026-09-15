-- The starting source registry. OPPORTUNITY_INGESTION.md §7.
--
-- §7 `[PR]`, and it is the reason every row here is INACTIVE:
--
--   "Each requires an individual robots/ToS check before activation — this table is
--    a research starting point, not an approval list."
--
-- So this seed records what was researched, not what was approved. Activation needs
-- two things: a robots.txt check (objective, automated by scripts/check-source.mjs)
-- and a terms-of-service judgement (not objective, and not a coding agent's call).
-- The schema already refuses to activate a source without a recorded robots check —
-- `CHECK (NOT is_active OR (robots_allowed IS TRUE AND robots_checked_at IS NOT NULL))`
-- — so the half that can be enforced is enforced rather than trusted.
--
-- Tier order is §2's and is not a preference: "Never skip to a lower tier when a
-- higher one is available." Feeds are tier 2 and the backbone; the HTML sources at
-- the bottom are tier 6, last resort, per-source legal review required.
--
-- URLs are the canonical feed or programme page found during research. Several will
-- have moved by the time anyone activates them; the check script reports that rather
-- than failing silently.

-- MEASURED 2026-09-15, BEFORE LAUNCH. Migration 0030 is the authority for a database
-- that already exists; these URLs are kept in step so a FRESH database starts where the
-- live one ended up rather than repeating a pass that has already been done.
--
-- Five rows below point at a programme page rather than a home page. discover() treats
-- an html_page source as a single document, so a row pointing at "/" spends a fetch, a
-- possible browser render and two model calls per run on a navigation menu. The home
-- pages extracted to things like "Study @ Unza Undergraduates Postgraduates
-- International Students Distance Education" — nothing a model can find a grant in.
--
-- Nine rows here are inactive in the live database for the same reason and 0030 says
-- which and why. They are left in this file because the research in them is real and
-- because deleting a row invites someone to re-add it without the finding attached.
--
INSERT INTO sources
  (name, kind, url, cadence_minutes, tos_posture, legal_note, attribution_required,
   default_region, trust_score, is_active)
VALUES
  -- ── Tier 2: RSS. Publisher-intended machine consumption. ──────────────────
  ('Opportunity Desk', 'rss', 'https://opportunitydesk.org/feed/', 180, NULL,
   'Tier 2 RSS. Very high volume, global plus Africa. Check the feed''s own terms before activating.',
   true, 'africa_wide', 0.50, false),
  ('Opportunities for Africans', 'rss', 'https://www.opportunitiesforafricans.com/feed/', 180, NULL,
   'Tier 2 RSS. Africa-focused, which is the whole catalogue rather than a slice of it.',
   true, 'africa_wide', 0.50, false),
  -- CHECKED 14 September 2026: robots.txt DISALLOWS `*/feed`, so this feed is off
  -- limits despite §7 listing it as a tier-2 RSS source. Exactly what §7 means by
  -- "a research starting point, not an approval list". Left here, inactive, with
  -- the finding recorded — deleting the row would invite someone to re-add it.
  ('After School Africa', 'rss', 'https://www.afterschoolafrica.com/feed/', 240, 'restricts_automation',
   'Tier 2 RSS in §7''s table, but robots.txt disallows */feed (checked 2026-09-14). Not usable by crawl. If their content matters, ask them for permission and record it as tos_posture=permits_feeds.',
   true, 'africa_wide', 0.50, false),
  ('Scholarship Region', 'rss', 'https://www.scholarshipregion.com/feed/', 240, NULL,
   'Tier 2 RSS. Also publishes to Telegram and WhatsApp, so items may appear here after reaching readers elsewhere.',
   true, 'africa_wide', 0.50, false),
  ('TechCabal', 'rss', 'https://techcabal.com/feed/', 360, NULL,
   'Tier 2 RSS. Also runs Moonshot and TC Battlefield, which are opportunities in their own right.',
   true, 'africa_wide', 0.50, false),
  ('Techpoint Africa', 'rss', 'https://techpoint.africa/feed/', 360, NULL,
   'Tier 2 RSS.', true, 'africa_wide', 0.50, false),
  ('Disrupt Africa', 'rss', 'https://disruptafrica.com/feed/', 360, NULL,
   'Tier 2 RSS. Startup programmes and funding.', true, 'africa_wide', 0.50, false),

  -- ── Tier 1: official APIs. Explicitly sanctioned. ─────────────────────────
  ('Kaggle competitions', 'kaggle_api', 'https://www.kaggle.com/api/v1/competitions/list', 720, 'permits_feeds',
   'Tier 1. Official API, explicitly sanctioned. Needs credentials; §2.1 rule 2 still forbids using them to reach anything a signed-out user could not.',
   true, NULL, 0.70, false),
  ('GitHub good-first-issue programmes', 'github_api', 'https://api.github.com/search/repositories', 720, 'permits_feeds',
   'Tier 1. Official API, so robots.txt is not the governing document — the API terms are, and they permit this. The robots check will report it as unreadable because api.github.com serves no robots.txt; that is expected for an API endpoint and is not a refusal.',
   true, NULL, 0.70, false),

  -- ── Tier 3: structured data on public pages. ──────────────────────────────
  ('GDG chapter events', 'jsonld', 'https://gdg.community.dev/chapters/', 720, NULL,
   'Tier 3. JSON-LD Event data. Country-level events, high value in Tier-1 markets.',
   true, 'africa_wide', 0.50, false),

  -- ── Tier 6: scoped HTML. LAST RESORT, per-source legal review required. ───
  ('Zindi competitions', 'html_page', 'https://zindi.africa/competitions', 360, NULL,
   'Tier 6. Priority African ML competitions. §7 flags this one explicitly: legal check required before activation.',
   true, 'africa_wide', 0.50, false),
  ('Tony Elumelu Foundation', 'html_page', 'https://www.tonyelumelufoundation.org/tef-entrepreneurship-programme/', 1440, NULL,
   'Tier 6. Direct organisation source, so provenance is good where the terms allow it.',
   true, 'africa_wide', 0.60, false),
  ('Mastercard Foundation', 'html_page', 'https://mastercardfdn.org/en/what-we-do/our-programs/mastercard-foundation-scholars-program/', 1440, NULL,
   'Tier 6. Direct organisation source.', true, 'africa_wide', 0.60, false),
  ('Anzisha Prize', 'html_page', 'https://anzishaprize.org/', 1440, NULL,
   'Tier 6. NOTE: under-18 eligible. PRODUCT_SPEC.md §22.1 — list it, but accounts stay 18+.',
   true, 'africa_wide', 0.60, false),
  ('Africa''s Business Heroes', 'html_page', 'https://africabusinessheroes.org/en/the-prize/application-guidelines', 1440, NULL,
   'Tier 6. Direct organisation source.', true, 'africa_wide', 0.60, false),
  ('Deep Learning Indaba', 'html_page', 'https://deeplearningindaba.com/', 1440, NULL,
   'Tier 6. Per-country IndabaX chapters are separate sources worth adding individually. Its robots.txt did not respond when checked on 2026-09-14; re-run the check before drawing any conclusion — an unreachable robots.txt is treated as a refusal, which is the safe reading but not necessarily a permanent one.',
   true, 'africa_wide', 0.60, false),
  ('She Code Africa', 'html_page', 'https://shecodeafrica.org/', 1440, NULL,
   'Tier 6. Produces gender_restricted rules — handle carefully. PRODUCT_SPEC.md §12.2: gender is self-declared, never inferred, and used only for rules like these.',
   true, 'africa_wide', 0.60, false),
  ('MEST Africa', 'html_page', 'https://meltwater.org/mestx/', 1440, NULL,
   'Tier 6. Accelerator cycles.', true, 'africa_wide', 0.55, false),
  ('CcHUB', 'html_page', 'https://cchubnigeria.com/', 1440, NULL,
   'Tier 6. Accelerator cycles.', true, 'africa_wide', 0.55, false),
  ('Injini', 'html_page', 'https://injini.co.za/edtech-fellowship', 1440, NULL,
   'Tier 6. EdTech accelerator, South Africa.', true, 'africa_wide', 0.55, false),

  -- ── The deliberate priority. §7 `[C]`. ────────────────────────────────────
  -- "University and national programme pages in Zimbabwe, Zambia, Botswana,
  -- Namibia, Malawi and Mozambique are where no incumbent looks. They are
  -- low-volume and awkward to fetch, which is exactly why they are defensible."
  --
  -- Listed as placeholders naming the CLASS rather than guessed URLs: a wrong URL
  -- here would be a source that silently fetches a 404 forever, and §3's health
  -- alerting would then be firing on our own mistake. An operator adds the real
  -- ones through the admin form, which §3 marks `[PR]` as the way sources are added.
  ('University of Zimbabwe — research and innovation', 'html_page', 'https://www.uz.ac.zw/', 2880, NULL,
   'Tier 6, and §7 `[C]`''s highest-value lowest-competition class. URL is the institution root: an operator points it at the actual programme page, because guessing one produces a source that fetches a 404 forever.',
   true, 'africa_wide', 0.55, false),
  ('University of Zambia — opportunities', 'html_page', 'https://www.unza.zm/', 2880, NULL,
   'Tier 6, §7 `[C]`. Same note as above.', true, 'africa_wide', 0.55, false),
  ('University of Botswana — opportunities', 'html_page', 'https://www.ub.bw/', 2880, NULL,
   'Tier 6, §7 `[C]`. Same note as above.', true, 'africa_wide', 0.55, false),
  ('University of Namibia — opportunities', 'html_page', 'https://www.unam.edu.na/', 2880, NULL,
   'Tier 6, §7 `[C]`. Same note as above.', true, 'africa_wide', 0.55, false)
-- `(url)`, not a bare `ON CONFLICT DO NOTHING`. Without a target this clause needs some
-- constraint to conflict on, and `sources` had none until migration 0025 — so eighteen deploys
-- re-seeded this file into 432 rows and the clause suppressed nothing. A conflict target is
-- what makes "idempotent" a fact rather than a comment.
ON CONFLICT (url) DO NOTHING;
