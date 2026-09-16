-- 0035 two tasks the CHECK constraint had never heard of
--
-- 0013 wrote the task vocabulary as a CHECK: ('extract','rules','brief','query','dedupe',
-- 'moderate'). Adding a `summarise` task meant adding rows to supabase/seed/005_ai_providers.sql,
-- and a CHECK violation is an ERROR rather than a conflict, so `ON CONFLICT DO NOTHING` does
-- not absorb it: the seed would have failed outright, and had it been allowed through,
-- `ai_chain_for('summarise')` would have returned zero rows and every summary backfill would
-- have reported "no provider" forever.
--
-- This is the same class of defect as the one it accompanies — a vocabulary written down
-- twice, in a prompt and in the `categories` table, drifting because nobody reads two lists
-- side by side. Here it is a CHECK and a seed file. The difference is that a CHECK fails
-- loudly, which is the only reason this one was cheap.
--
-- `classify` joins it in the same migration: the model pass that reads what a title could
-- not answer (prompts/classify.v1.md).
--
-- A CHECK is still the right shape for this. The alternative — a `tasks` table with a
-- foreign key — buys nothing: a task is not configuration, it is a code path with a prompt
-- file, so a task name that no code asks for is dead weight rather than a feature.

ALTER TABLE ai_providers DROP CONSTRAINT IF EXISTS ai_providers_task_check;

ALTER TABLE ai_providers
  ADD CONSTRAINT ai_providers_task_check
  CHECK (task IN ('extract','rules','brief','query','dedupe','moderate','summarise','classify'));
