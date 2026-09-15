-- 0026 the three models the chain pointed at had all been retired
--
-- On 2026-09-15 every extraction in production failed, and the log said
-- `extraction_failed` without saying why. With the reason surfaced, all three providers
-- were answering 404 to every call:
--
--   gemini    models/gemini-2.5-flash "is no longer available to new users.
--             Please update your code to use models/gemini-3.6-flash"
--   groq      "The model `llama-3.1-8b-instant` does not exist or you do not have
--             access to it" — it is now listed as Llama 3.1 8B Enterprise, Contact Sales
--   cerebras  "Model does not exist or you do not have access to it" — llama3.1-8b is
--             gone from the public endpoints, which now serve gpt-oss-120b and
--             qwen-3.8-27b only
--
-- AI_SYSTEM.md §2 guardrail 6 `[PR]` called this: "Free catalogues change without notice
-- (Cerebras has dropped models silently; Gemini removed Pro from the free tier)." The
-- guardrail was right and the seed still had to be corrected by hand.
--
-- WHY A MIGRATION AND NOT JUST THE SEED. ai_providers is UNIQUE (provider, task, model)
-- and 005_ai_providers.sql ends in ON CONFLICT DO NOTHING. Changing a model name there
-- makes a NEW row on the next `npm run db:seed`, and leaves the retired row enabled
-- beside it — so the chain would try the dead model first on priority and the seed edit
-- would look applied while changing nothing. The rows have to be updated in place.
--
-- Each statement names the old value in its WHERE clause. An operator who has already
-- fixed a row by hand keeps their fix, and a re-run changes nothing.

-- Extraction takes long documents, so each provider's larger model.
UPDATE ai_providers SET model = 'gemini-3.6-flash'
 WHERE provider = 'gemini' AND model = 'gemini-2.5-flash';

UPDATE ai_providers SET model = 'openai/gpt-oss-120b'
 WHERE provider = 'groq' AND task = 'extract' AND model = 'llama-3.1-8b-instant';

UPDATE ai_providers SET model = 'gpt-oss-120b'
 WHERE provider = 'cerebras' AND model = 'llama3.1-8b';

-- Rules, brief, query and dedupe are short and high volume, so the small fast model —
-- the role llama-3.1-8b-instant held before it was withdrawn.
UPDATE ai_providers SET model = 'openai/gpt-oss-20b'
 WHERE provider = 'groq' AND model = 'llama-3.1-8b-instant';
