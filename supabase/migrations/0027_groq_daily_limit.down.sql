-- Restores the previous ceiling. It was wrong — 14,000 against a published 1,000 — so
-- this rolls back the row's content rather than restoring anything worth having.
UPDATE ai_providers SET daily_request_limit = 14000
 WHERE provider = 'groq' AND daily_request_limit = 950;
