-- 0030 every active source now points at something that lists opportunities
--
-- Written against a launch. Each change below is a measurement taken on 2026-09-15,
-- not a judgement about the organisation: several of the sources being switched off do
-- excellent work, and none of them publishes it at the URL this registry was reading.
--
-- WHAT WAS WRONG. Thirteen of the seventeen active sources were `html_page` or `jsonld`
-- rows pointing at a site's ROOT. discover() treats such a source as a single document
-- — the home page — so each one spent a fetch, often a browser render, and two model
-- calls per run on a navigation menu. The extracted text says so plainly:
--
--   University of Zimbabwe   "UZ | Research & Innovation Quality Assurance Gallery
--                             Contact Us Job Corner Alumni Association ..."
--   University of Zambia     "Study @ Unza Undergraduates Postgraduates International
--                             Students Distance Education E-Campus ..."
--   CcHUB                    "Security Verification Please verify you're human to
--                             continue Loading verification... Who we are ..."
--   Tony Elumelu Foundation  "Celebrating 16 years of empowering African entrepreneurs
--                             ... Watch The 2024 TEF TV Commercial"
--
-- A model asked to find a grant in a navigation bar finds nothing, correctly, and the
-- run records an extraction failure. On free provider tiers where 8,000 tokens a minute
-- decides how much of the catalogue gets read, that is the budget.

-- ── Repointed: the organisation is right, the URL was not ───────────────────
--
-- Each target was fetched and measured. etag and last_modified are cleared because they
-- describe the OLD document: left in place, the next conditional request would carry a
-- validator for a page this source no longer reads and could be answered 304 — a source
-- that looks healthy and ingests nothing, which is the hardest kind of failure to see.

UPDATE sources SET
  url = 'https://www.tonyelumelufoundation.org/tef-entrepreneurship-programme/',
  etag = NULL, last_modified = NULL, consecutive_failures = 0,
  legal_note = 'Tier 6, repointed 2026-09-15 from the home page (marketing copy, 7,890 chars) to the TEF Entrepreneurship Programme itself (18,481 chars). The programme is the opportunity.'
 WHERE name = 'Tony Elumelu Foundation';

UPDATE sources SET
  url = 'https://mastercardfdn.org/en/what-we-do/our-programs/mastercard-foundation-scholars-program/',
  etag = NULL, last_modified = NULL, consecutive_failures = 0,
  legal_note = 'Tier 6, repointed 2026-09-15 from the home page to the Scholars Program (13,910 chars, states where to apply). The /en/events/ listing was measured too and renders client-side to 74 characters, so it was not used.'
 WHERE name = 'Mastercard Foundation';

UPDATE sources SET
  url = 'https://injini.co.za/edtech-fellowship',
  etag = NULL, last_modified = NULL, consecutive_failures = 0,
  legal_note = 'Tier 6, repointed 2026-09-15 from the home page (5,185 chars of positioning) to the Mastercard Foundation EdTech Fellowship (13,568 chars).'
 WHERE name = 'Injini';

UPDATE sources SET
  url = 'https://africabusinessheroes.org/en/the-prize/application-guidelines',
  etag = NULL, last_modified = NULL, consecutive_failures = 0,
  legal_note = 'Tier 6, repointed 2026-09-15 from the home page to the competition''s own application guidelines (9,240 chars).'
 WHERE name = 'Africa''s Business Heroes';

UPDATE sources SET
  url = 'https://meltwater.org/mestx/',
  etag = NULL, last_modified = NULL, consecutive_failures = 0,
  legal_note = 'Tier 6, repointed 2026-09-15 from the home page to the MESTx programme listing (6,593 chars).'
 WHERE name = 'MEST Africa';

-- ── Switched off: measured, and there is no opportunity at the other end ────
--
-- Deactivated rather than deleted. Every row keeps its robots finding, its legal note
-- and its history, and any of them comes back with one UPDATE the day it publishes a
-- page worth reading.

UPDATE sources SET is_active = false, legal_note = COALESCE(legal_note, '') ||
  ' DEACTIVATED 2026-09-15: the home page extracts to a navigation menu and admissions
 copy, not opportunities. A university''s degree admissions are not a catalogue
 opportunity. Re-point at a funded-call or vacancies page and re-activate.'
 WHERE name IN ('University of Zimbabwe — research and innovation',
                'University of Zambia — opportunities',
                'University of Botswana — opportunities',
                'University of Namibia — opportunities');

UPDATE sources SET is_active = false, legal_note = COALESCE(legal_note, '') ||
  ' DEACTIVATED 2026-09-15: the home page serves "Security Verification — Please verify
 you''re human to continue" ahead of marketing copy, and carries no call to apply. The
 wall is not the reason; the absence of an opportunity is.'
 WHERE name = 'CcHUB';

UPDATE sources SET is_active = false, legal_note = COALESCE(legal_note, '') ||
  ' DEACTIVATED 2026-09-15: home page is 3,256 chars of positioning and /events renders
 to 881. Nothing to extract. Worth revisiting when the events page carries listings.'
 WHERE name = 'She Code Africa';

UPDATE sources SET is_active = false, legal_note = COALESCE(legal_note, '') ||
  ' DEACTIVATED 2026-09-15: /chapters/ is a directory of chapter NAMES — 115,134 chars of
 them — not a list of events. It filled the model''s whole input with place names. The
 source is worth having again pointed at an events endpoint, not this one.'
 WHERE name = 'GDG chapter events';

UPDATE sources SET is_active = false, legal_note = COALESCE(legal_note, '') ||
  ' DEACTIVATED 2026-09-15: answers HTTP 401 on every run — the endpoint needs an API
 key that is not configured — and kind=kaggle_api has no adapter in apis.mjs, so it
 would not parse even with one. Both are fixable; until then it is a guaranteed failure
 every run.'
 WHERE name = 'Kaggle competitions';

-- ── Switched on: measured, and every item is a call to apply ────────────────
--
-- robots.txt was fetched and parsed for each of these on 2026-09-15 and allows the path
-- being read; that is the objective half of §7's check and it is recorded below.
--
-- tos_posture is deliberately left NULL. §7 and scripts/check-source.mjs both say the
-- terms of service is "a judgement about someone else's legal document" that a person
-- makes, and nobody has read these. The operator authorised activation for launch with
-- that outstanding, which is a decision that belongs in the record rather than in a
-- chat log.

UPDATE sources SET
  is_active = true, robots_allowed = true, robots_checked_at = now(),
  legal_note = 'Tier 1 official API, no key. robots.txt wildcard group is an empty Disallow: — every agent allowed, only BLEXBot named and banned (checked 2026-09-15). 180 open hackathons; the first nine each produced title, organiser, start, end, deadline, URL and mode with NO model call. OUTSTANDING: terms of service not yet read by a person.'
 WHERE name = 'Devpost hackathons';

UPDATE sources SET
  is_active = true, robots_allowed = true, robots_checked_at = now(),
  legal_note = 'Tier 2 RSS. robots.txt allows the feed (checked 2026-09-15). Sampled the same day: 10/10 items were calls to apply — bursaries, development programmes, funded courses. Plain HTTP, no bot wall. OUTSTANDING: terms of service not yet read by a person.'
 WHERE name = 'Youth Opportunities Hub';

UPDATE sources SET
  is_active = true, robots_allowed = true, robots_checked_at = now(),
  legal_note = 'Tier 2 RSS. robots.txt allows the feed (checked 2026-09-15). Sampled the same day: 10/10 items were calls to apply — fellowships, internships, mentorship programmes. Global rather than Africa-first, so expect a lower share to clear eligibility. OUTSTANDING: terms of service not yet read by a person.'
 WHERE name = 'Opportunities For Youth';

-- ── Repaired: the host in the registry is the one behind the wall ───────────
--
-- scholarshipregion.com (bare) answered the feed with a Sucuri interstitial the browser
-- could not solve; www.scholarshipregion.com served the same feed over plain HTTP with
-- ten items. Same publisher, same content, one hostname apart.
UPDATE sources SET
  url = 'https://www.scholarshipregion.com/feed/',
  etag = NULL, last_modified = NULL, consecutive_failures = 0,
  legal_note = 'Tier 2 RSS. Repointed 2026-09-15 to the www host: the bare domain answers the feed with a Sucuri proof-of-work the browser could not pass, while www serves it directly. NOTE: roughly 3 of 10 items are study guides rather than calls to apply, and those will be discarded after costing a model call.'
 WHERE name = 'Scholarship Region';
