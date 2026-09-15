-- 0029 the registry was reading news sites for opportunities
--
-- The run of 2026-09-15 fetched 58 documents and stored one. Thirty of the fifty-eight
-- were TechCabal and Techpoint articles, and the two that reached a model came back
-- `discarded` — correctly, because "MTN controls 55% of Nigeria's tiny fibre market" is
-- a news story and this catalogue holds opportunities. On free provider tiers where a
-- token-per-minute ceiling decides how much of the registry gets read in a day, those
-- thirty documents were the whole budget spent on things that cannot become records.
--
-- §2's source priority table never asked for news. It ranks official APIs first, then
-- publisher feeds, then structured data on public pages. News sites are not on it.
--
-- WHAT LEAVES. The three sources whose feeds are articles about the ecosystem rather
-- than calls to apply. Deactivated, not deleted: they carry robots findings and a legal
-- note someone did the work for, and Disrupt Africa in particular does occasionally
-- carry an open call, so this is a judgement that may be revisited rather than a fact.
UPDATE sources SET is_active = false
 WHERE name IN ('TechCabal', 'Techpoint Africa', 'Disrupt Africa');

-- WHAT ARRIVES. An API adapter column first: §2 tier 1 is "official API, explicitly
-- sanctioned", and the pipeline could not read one — discover() implemented rss, atom,
-- sitemap, jsonld and html_page, so every *_api row fell through to "no discovery
-- implemented" and the top of the priority table was decorative.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS api_adapter text;

COMMENT ON COLUMN sources.api_adapter IS
  'Which adapter in packages/ingest/src/apis.mjs parses this API''s response. Required '
  'for kind=json_api and meaningless otherwise. Adapters return schema.org nodes, so an '
  'API source reaches a record with no model call at all.';

ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_api_adapter_for_api_kinds;
ALTER TABLE sources ADD CONSTRAINT sources_api_adapter_for_api_kinds
  CHECK (kind <> 'json_api' OR api_adapter IS NOT NULL);

-- Devpost. The largest hackathon listing there is, and tier 1 on every count: a public
-- JSON endpoint with no key, and a robots.txt whose wildcard group is an empty
-- `Disallow:` — every agent allowed, only BLEXBot named and banned.
--
-- Measured on 2026-09-15: 180 open or upcoming hackathons, nine per page, and every one
-- of the nine on the first page produced a record carrying title, organiser, start, end,
-- application deadline, official URL and participation mode — from the API's own fields,
-- with no model involved. `cost` is deliberately absent: Devpost does not state whether
-- entry is free, and invariant 13 turns on that field.
--
-- INACTIVE, like everything else added here. §7 `[PR]`: "Each requires an individual
-- robots/ToS check before activation — this table is a research starting point, not an
-- approval list." robots is machine-checkable and has been checked; the terms of service
-- is a judgement about someone else's legal document and belongs to a person.
INSERT INTO sources
  (name, kind, url, api_adapter, cadence_minutes, tos_posture, legal_note,
   attribution_required, trust_score, is_active)
VALUES
  ('Devpost hackathons', 'json_api',
   'https://devpost.com/api/hackathons?status[]=open&status[]=upcoming',
   'devpost_hackathons', 360, NULL,
   'Tier 1. Public JSON endpoint, no key. robots.txt allows every agent but BLEXBot, checked 2026-09-15. Returns schema.org-shaped data, so it costs no model calls. CHECK THE TERMS OF SERVICE BEFORE ACTIVATING.',
   true, 0.70, false),

  -- Two opportunity aggregators, measured the same day. Both feeds returned ten items
  -- and every item was a call to apply — bursaries, fellowships, internships,
  -- programmes — which is the difference between these and what is being switched off
  -- above. Both fetch over plain HTTP with no challenge, so they cost no browser either.
  ('Youth Opportunities Hub', 'rss', 'https://youthopportunitieshub.com/feed/', NULL,
   240, NULL,
   'Tier 2 RSS. Sampled 2026-09-15: 10/10 items were opportunities (bursaries, development programmes, funded courses). Plain HTTP, no bot wall. CHECK THE TERMS OF SERVICE BEFORE ACTIVATING.',
   true, 0.50, false),

  ('Opportunities For Youth', 'rss', 'https://opportunitiesforyouth.org/feed/', NULL,
   240, NULL,
   'Tier 2 RSS. Sampled 2026-09-15: 10/10 items were opportunities (fellowships, internships, mentorship programmes). Global rather than Africa-first, so expect a lower share to pass eligibility. Plain HTTP, no bot wall. CHECK THE TERMS OF SERVICE BEFORE ACTIVATING.',
   true, 0.50, false)
ON CONFLICT (url) DO NOTHING;
