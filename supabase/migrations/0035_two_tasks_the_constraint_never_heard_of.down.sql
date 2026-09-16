-- Narrows the vocabulary back to 0013's six. Any summarise or classify rows must go first,
-- or the constraint will refuse to be added — which is the constraint working.
DELETE FROM ai_providers WHERE task IN ('summarise','classify');

ALTER TABLE ai_providers DROP CONSTRAINT IF EXISTS ai_providers_task_check;

ALTER TABLE ai_providers
  ADD CONSTRAINT ai_providers_task_check
  CHECK (task IN ('extract','rules','brief','query','dedupe','moderate'));
