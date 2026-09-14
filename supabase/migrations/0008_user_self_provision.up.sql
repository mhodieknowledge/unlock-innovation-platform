-- 0008 self-provisioning for a newly authenticated user
--
-- Supabase Auth creates a row in auth.users. This product's own `users` table is
-- separate and carries the product fields (handle, account_state,
-- age_confirmed_18, timezone). Something has to bridge the two on first sign-in.
--
-- Done with an INSERT policy scoped to the caller's own id rather than a
-- service-role write or an auth-schema trigger, for two reasons: the service key
-- must never reach the request tier (SECURITY.md §2), and a policy keeps the rule
-- visible in the same place as every other access rule instead of hidden in a
-- platform-schema trigger.

-- A user may create exactly one row, and only their own.
CREATE POLICY users_insert_self ON users FOR INSERT
  WITH CHECK (id = auth.uid());

-- The two owned side tables are created by their owner on demand.
CREATE POLICY profiles_insert_self ON profiles FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY eligibility_profiles_insert_self ON eligibility_profiles FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY notif_settings_insert_self ON user_notification_settings FOR INSERT
  WITH CHECK (user_id = auth.uid());

/**
 * Profile completeness, for the "what this unlocks" prompts.
 *
 * UX_FLOWS.md §8.1 calls the eligibility tab "the most important settings screen
 * in the product" and wants each field to show what it unlocks. This computes the
 * percentage; which single field to prompt for next is decided in the
 * application, where it can be ranked against the rules a user has actually met.
 *
 * Weighted, not a plain field count: country and student status resolve far more
 * high-stakes rules than a language list does, and a meter that treats them
 * equally would send people to the wrong field first.
 */
CREATE OR REPLACE FUNCTION eligibility_completeness(p_user_id uuid)
RETURNS smallint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT LEAST(100, GREATEST(0, (
      CASE WHEN country_of_residence IS NOT NULL       THEN 30 ELSE 0 END
    + CASE WHEN cardinality(nationalities) > 0         THEN 10 ELSE 0 END
    + CASE WHEN birth_year IS NOT NULL                 THEN 20 ELSE 0 END
    + CASE WHEN student_status IS NOT NULL             THEN 20 ELSE 0 END
    + CASE WHEN year_of_study IS NOT NULL              THEN  5 ELSE 0 END
    + CASE WHEN institution_type IS NOT NULL           THEN  5 ELSE 0 END
    + CASE WHEN years_experience IS NOT NULL           THEN  5 ELSE 0 END
    + CASE WHEN cardinality(languages) > 0             THEN  5 ELSE 0 END
  )))::smallint
  FROM eligibility_profiles
  WHERE user_id = p_user_id
$$;

REVOKE ALL ON FUNCTION eligibility_completeness(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eligibility_completeness(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION eligibility_profiles_set_completeness()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.completeness := LEAST(100, GREATEST(0, (
      CASE WHEN NEW.country_of_residence IS NOT NULL       THEN 30 ELSE 0 END
    + CASE WHEN cardinality(NEW.nationalities) > 0         THEN 10 ELSE 0 END
    + CASE WHEN NEW.birth_year IS NOT NULL                 THEN 20 ELSE 0 END
    + CASE WHEN NEW.student_status IS NOT NULL             THEN 20 ELSE 0 END
    + CASE WHEN NEW.year_of_study IS NOT NULL              THEN  5 ELSE 0 END
    + CASE WHEN NEW.institution_type IS NOT NULL           THEN  5 ELSE 0 END
    + CASE WHEN NEW.years_experience IS NOT NULL           THEN  5 ELSE 0 END
    + CASE WHEN cardinality(NEW.languages) > 0             THEN  5 ELSE 0 END
  )))::smallint;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER eligibility_profiles_completeness
  BEFORE INSERT OR UPDATE ON eligibility_profiles
  FOR EACH ROW EXECUTE FUNCTION eligibility_profiles_set_completeness();
