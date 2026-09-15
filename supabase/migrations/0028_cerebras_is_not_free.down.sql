-- Puts Cerebras back in the chain. It will answer 402 on every call until the account
-- has billing, which is the state this migration was written to get out of.
UPDATE ai_providers SET enabled = true WHERE provider = 'cerebras';
