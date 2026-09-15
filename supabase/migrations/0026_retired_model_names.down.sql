-- Puts the retired model names back.
--
-- This restores the schema's previous CONTENT, not a working state: every name below
-- answered 404 on 2026-09-15 and will go on doing so. The down migration exists because
-- every migration here has one and because rolling back a deploy should not leave rows
-- the rest of that deploy's code does not expect — not because anyone should want this.
UPDATE ai_providers SET model = 'gemini-2.5-flash'
 WHERE provider = 'gemini' AND model = 'gemini-3.6-flash';

UPDATE ai_providers SET model = 'llama-3.1-8b-instant'
 WHERE provider = 'groq' AND model IN ('openai/gpt-oss-120b', 'openai/gpt-oss-20b');

UPDATE ai_providers SET model = 'llama3.1-8b'
 WHERE provider = 'cerebras' AND model = 'gpt-oss-120b';
