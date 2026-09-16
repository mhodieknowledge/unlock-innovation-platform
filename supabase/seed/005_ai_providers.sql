-- AI provider chain. AI_SYSTEM.md §3.1.
--
-- These are CONFIGURATION, seeded here so a fresh database has a working chain, and
-- editable afterwards without a deploy. §2 guardrail 6 `[PR]` is the reason: "Free
-- catalogues change without notice (Cerebras has dropped models silently; Gemini
-- removed Pro from the free tier)." When that happens the fix is an UPDATE.
--
-- CEREBRAS IS DISABLED in any database that has run migration 0028: on 2026-09-15 it
-- answered every call with 402 "Payment required to access this resource." Its rows are
-- kept here and there because they hold researched configuration and because a free
-- allowance may come back — but nothing in this chain should be counted on to answer
-- until someone checks that it does.
--
-- RETIRED ONCE ALREADY. On 2026-09-15 all three models here answered 404: Gemini said
-- gemini-2.5-flash "is no longer available to new users", Groq moved
-- llama-3.1-8b-instant behind Contact Sales, and Cerebras dropped llama3.1-8b from its
-- public endpoints. The pipeline stored nothing for a day and a half. The guardrail
-- below predicted exactly this, which is why the fix is an UPDATE and why migration
-- 0026 carries it to databases that already hold the old rows — ON CONFLICT here is
-- DO NOTHING against UNIQUE (provider, task, model), so editing this file alone would
-- add a second row and leave the dead one enabled beside it.
--
-- The quotas are the free-tier ceilings §3.1 records. They are deliberately set a
-- little under the published figures: the accountant stops before the limit rather
-- than learning it as a 429, and a 429 costs a retry plus a fifteen-minute breaker.
--
-- Routing is BY TASK (§3.1's second table), not one global order:
--   extraction (long HTML) -> Gemini Flash first, for the large context
--   rule derivation        -> Groq 8B first, short structured high volume
--   brief decoder          -> Gemini Flash, long rules documents
--   query compiler         -> Groq, latency-sensitive
--   dedupe adjudication    -> Groq, one short question
--   moderation pre-screen   -> Workers AI, edge-local and tiny

INSERT INTO ai_providers
  (provider, task, model, priority, daily_request_limit, requests_per_minute,
   trains_on_input, endpoint, api_key_env, notes)
VALUES
  -- ── Extraction: long documents, so context size decides the order ─────────
  ('gemini', 'extract', 'gemini-3.6-flash', 10, 1400, 15, true,
   'https://generativelanguage.googleapis.com/v1beta/models', 'GEMINI_API_KEY',
   'Large context handles a full page without chunking. TRAINS ON INPUT: public web content only, never user data (§2 guardrail 5).'),
  ('groq', 'extract', 'openai/gpt-oss-120b', 20, 950, 30, false,
   'https://api.groq.com/openai/v1/chat/completions', 'GROQ_API_KEY',
   'Fallback when Gemini is exhausted. TPM binds before RPD on long inputs.'),
  ('cerebras', 'extract', 'gpt-oss-120b', 30, 14000, 30, false,
   'https://api.cerebras.ai/v1/chat/completions', 'CEREBRAS_API_KEY',
   'Third in the chain. Volatile catalogue — check the model name when this starts failing.'),

  -- ── Rule derivation: the most constrained task in the system ──────────────
  ('groq', 'rules', 'openai/gpt-oss-20b', 10, 950, 30, false,
   'https://api.groq.com/openai/v1/chat/completions', 'GROQ_API_KEY',
   'Short, structured, high volume. Output is verbatim-quote validated regardless of model.'),
  ('cerebras', 'rules', 'gpt-oss-120b', 20, 14000, 30, false,
   'https://api.cerebras.ai/v1/chat/completions', 'CEREBRAS_API_KEY', NULL),
  ('gemini', 'rules', 'gemini-3.6-flash', 30, 1400, 15, true,
   'https://generativelanguage.googleapis.com/v1beta/models', 'GEMINI_API_KEY',
   'Last resort for rules: the task is small and Gemini quota is better spent on long extractions.'),

  -- ── Brief decoder: long rules documents and PDFs ──────────────────────────
  ('gemini', 'brief', 'gemini-3.6-flash', 10, 1400, 15, true,
   'https://generativelanguage.googleapis.com/v1beta/models', 'GEMINI_API_KEY', NULL),
  ('groq', 'brief', 'openai/gpt-oss-20b', 20, 950, 30, false,
   'https://api.groq.com/openai/v1/chat/completions', 'GROQ_API_KEY', NULL),

  -- ── Query compiler: latency matters, it runs in a request ─────────────────
  ('groq', 'query', 'openai/gpt-oss-20b', 10, 950, 30, false,
   'https://api.groq.com/openai/v1/chat/completions', 'GROQ_API_KEY',
   'The ONE LLM call permitted in a request handler, and only because it is KV-cached for 7 days.'),

  -- ── Dedupe adjudication: one short question ───────────────────────────────
  -- Summarise: the smallest call in the system — a title and a few hundred words in, under
  -- 400 characters out. It exists because an API source costs no model calls and schema.org
  -- has no field for "what is this", so those records arrived with no description at all.
  ('groq', 'summarise', 'openai/gpt-oss-20b', 10, 950, 30, false,
   'https://api.groq.com/openai/v1/chat/completions', 'GROQ_API_KEY',
   'Tiny input, tiny output. First because it is the cheapest capable model in the chain and latency does not matter in a batch job.'),
  ('cerebras', 'summarise', 'gpt-oss-120b', 20, 14000, 30, false,
   'https://api.cerebras.ai/v1/chat/completions', 'CEREBRAS_API_KEY',
   'The deep quota. A backfill of a few hundred records fits inside a single day here.'),
  ('gemini', 'summarise', 'gemini-3.6-flash', 30, 1400, 15, true,
   'https://generativelanguage.googleapis.com/v1beta/models', 'GEMINI_API_KEY',
   'Last. TRAINS ON INPUT: public web content only, never user data (§2 guardrail 5).'),
  ('groq', 'dedupe', 'openai/gpt-oss-20b', 10, 950, 30, false,
   'https://api.groq.com/openai/v1/chat/completions', 'GROQ_API_KEY',
   'Only ever asked about a pair a deterministic check already flagged (§9 step 4).'),

  -- ── Moderation pre-screen: edge-local, tiny ───────────────────────────────
  ('workers_ai', 'moderate', '@cf/meta/llama-3.1-8b-instruct', 10, 9000, 60, false,
   NULL, NULL,
   'A Worker binding, not an HTTP key. Deterministic checks run first and are never skipped (§10 [PR]).')
ON CONFLICT (provider, task, model) DO NOTHING;
