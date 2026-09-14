-- 0015 "Your window" and "What should I do next"
--
-- PRODUCT_SPEC.md §14.1 and §14.2, both `[PR]`.
--
-- These two surfaces are what replaces the infinite feed, and the spec is unusually
-- specific about their shape because the shape IS the product decision: bounded, dated,
-- and every item saying why it is there. A feed optimises for time spent; these optimise
-- for something being done.
--
-- Both are SQL functions rather than application queries, for the same reason the
-- notification caps are: the caps are promises. "At most 8" and "max 5" enforced in a
-- page template are enforced until someone writes a second page.

/**
 * "Your window". §14.1 `[PR]`:
 *
 *   "Replaces the infinite feed. A bounded, dated surface: at most 8 items, all with
 *    deadlines in the next 30 days, all `eligible` or `likely_eligible`, ordered by
 *    urgency then fit. States what it is doing and why each item is there."
 *
 * Reads the precomputed recommendations (§8: "Zero compute at request time") and applies
 * §14.1's window on top. The eligibility gate is already in the precomputation, so this
 * re-filters on the deadline only.
 *
 * Returns a `source` column so the page can say which it is showing. §8 `[PR]` forbids an
 * empty recommendation surface and requires an HONEST label on the fallback, which the
 * page cannot produce if it cannot tell the two apart.
 */
CREATE OR REPLACE FUNCTION your_window(p_user_id uuid, p_limit int DEFAULT 8)
RETURNS TABLE (
  source text,
  slug text,
  title text,
  deadline_at timestamptz,
  deadline_precision text,
  is_rolling boolean,
  cost text,
  organisation_name text,
  category_name text,
  verdict text,
  reasons text[]
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_country char(2);
BEGIN
  -- Only ever the caller's own window. A user id parameter plus SECURITY DEFINER would
  -- otherwise be a way to read anyone's recommendations, which are derived from their
  -- eligibility profile — the one thing ADMIN_SYSTEM.md §6 keeps unreadable by everyone.
  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RETURN;
  END IF;

  -- FOUND after RETURN QUERY, rather than a pre-count.
  --
  -- The first version counted recommendations in the window and then returned a query
  -- that ALSO filtered by verdict — so a user whose profile had changed since the nightly
  -- run had a non-zero count and an empty result, and the country-board fallback never
  -- ran. That is exactly the empty personal surface §8 `[PR]` forbids, and a test that
  -- changed a country mid-run is what caught it.
  --
  -- Asking whether the real query returned anything cannot drift from what the real query
  -- filters on, because it IS the real query.
  RETURN QUERY
    SELECT 'recommendations'::text,
           o.slug, o.title, o.deadline_at, o.deadline_precision::text, o.is_rolling,
           o.cost::text, og.name, c.name,
           -- The verdict is recomputed rather than stored: a profile edited since the
           -- nightly run should change what the reader is told, and a stale verdict is
           -- the one thing this product must not show.
           v.verdict,
           r.reasons
      FROM user_recommendations r
      JOIN opportunities o ON o.id = r.opportunity_id
      LEFT JOIN organisations og ON og.id = o.organisation_id
      LEFT JOIN categories c ON c.id = o.category_id
      LEFT JOIN LATERAL (SELECT uv.verdict FROM user_verdicts(p_user_id, ARRAY[o.id]) uv) v ON true
     WHERE r.user_id = p_user_id
       AND o.status = 'published'
       AND o.deadline_at IS NOT NULL
       AND o.deadline_at > now()
       AND o.deadline_at <= now() + interval '30 days'
       -- §14.1: eligible or likely_eligible only. A recommendation that has become
       -- not_eligible since the nightly run is dropped rather than explained away.
       AND coalesce(v.verdict, 'unclear') IN ('eligible','likely_eligible')
     ORDER BY o.deadline_at, r.rank
     LIMIT greatest(1, p_limit);

  IF FOUND THEN
    RETURN;
  END IF;

  -- §8 `[PR]`: "Never show an empty recommendation surface — show the country's
  -- closing-soon list with an honest label instead." The label is the caller's job; the
  -- `source` column is what tells them which one to use.
  SELECT e.country_of_residence INTO v_country
    FROM eligibility_profiles e WHERE e.user_id = p_user_id;

  RETURN QUERY
  SELECT 'country_board'::text,
         b.slug, b.title, b.deadline_at, b.deadline_precision, b.is_rolling, b.cost,
         b.organisation_name,
         (SELECT c.name FROM categories c WHERE c.code = b.category_code),
         NULL::text,
         '{}'::text[]
    FROM closing_soon_for_country(v_country, p_limit) b;
END
$$;

/**
 * "What should I do next". §14.2 `[PR]`:
 *
 *   "A small, capped action list (max 5) assembled from DETERMINISTIC RULES over the
 *    user's own state, not from an LLM... Each item states the reason and links to one
 *    action. No motivational filler."
 *
 * Every rule below is one of §14.2's own examples or a direct analogue, and each returns
 * a reason built from a COUNT of the user's own data — "resolves eligibility on 12
 * opportunities", not "complete your profile for better results". A number a person can
 * check is the difference between a reason and a nudge.
 *
 * Two of §14.2's examples are not here: "a team room they joined with an unanswered
 * request" and "a project with new matched calls". Those features arrive in Phases 5 and
 * 6; the rules are absent rather than stubbed, because an action list that silently
 * omits a rule is better than one that invents an action.
 */
CREATE OR REPLACE FUNCTION next_actions(p_user_id uuid, p_limit int DEFAULT 5)
RETURNS TABLE (
  kind text,
  headline text,
  reason text,
  href text,
  priority int
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile eligibility_profiles;
  v_user users;
  v_count int;
  r record;
BEGIN
  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RETURN;
  END IF;

  SELECT * INTO v_user FROM users WHERE id = p_user_id;
  IF v_user.id IS NULL THEN RETURN; END IF;
  SELECT * INTO v_profile FROM eligibility_profiles WHERE user_id = p_user_id;

  -- 1. A saved item closing in <= 5 days. §14.2's first example, and the most concrete
  --    action this product can offer anyone.
  FOR r IN
    SELECT o.slug, o.title, o.deadline_at,
           greatest(1, ceil(extract(epoch FROM (o.deadline_at - now())) / 86400)::int) AS days
      FROM tracker_entries t
      JOIN opportunities o ON o.id = t.opportunity_id
     WHERE t.user_id = p_user_id
       AND t.state IN ('saved','planning_to_apply')
       AND o.status = 'published'
       AND o.deadline_at IS NOT NULL
       AND o.deadline_at > now()
       AND o.deadline_at <= now() + interval '5 days'
     ORDER BY o.deadline_at
     LIMIT 2
  LOOP
    RETURN QUERY SELECT
      'tracked_closing'::text,
      format('Finish your application: %s', r.title),
      format('You saved this and it closes in %s day%s.', r.days, CASE WHEN r.days = 1 THEN '' ELSE 's' END),
      format('/opportunities/%s', r.slug),
      1;
  END LOOP;

  -- 2. An eligible item closing within 7 days that is NOT yet tracked. §14.2's second
  --    example, minus the skills clause: skills matching arrives with projects in Phase 6,
  --    and an eligibility verdict is the stronger signal anyway.
  FOR r IN
    SELECT o.slug, o.title,
           greatest(1, ceil(extract(epoch FROM (o.deadline_at - now())) / 86400)::int) AS days
      FROM user_recommendations rec
      JOIN opportunities o ON o.id = rec.opportunity_id
      CROSS JOIN LATERAL (SELECT uv.verdict FROM user_verdicts(p_user_id, ARRAY[o.id]) uv) v
     WHERE rec.user_id = p_user_id
       AND o.status = 'published'
       AND o.deadline_at IS NOT NULL
       AND o.deadline_at > now()
       AND o.deadline_at <= now() + interval '7 days'
       AND v.verdict = 'eligible'
       AND NOT EXISTS (SELECT 1 FROM tracker_entries t
                        WHERE t.user_id = p_user_id AND t.opportunity_id = o.id)
     ORDER BY o.deadline_at, rec.rank
     LIMIT 2
  LOOP
    RETURN QUERY SELECT
      'eligible_closing'::text,
      format('You can enter this: %s', r.title),
      format('Your details meet every stated requirement, and it closes in %s day%s.', r.days, CASE WHEN r.days = 1 THEN '' ELSE 's' END),
      format('/opportunities/%s', r.slug),
      2;
  END LOOP;

  -- 3. An incomplete eligibility field blocking >= 5 verdicts. §14.2's last example, and
  --    the reason it names a NUMBER: "complete your student status — it will resolve
  --    eligibility on 12 opportunities" is checkable, and "complete your profile" is not.
  IF v_profile.user_id IS NULL OR v_profile.country_of_residence IS NULL THEN
    SELECT count(*)::int INTO v_count
      FROM eligibility_rules r2
      JOIN opportunities o ON o.id = r2.opportunity_id
     WHERE o.status = 'published'
       AND r2.rule_type IN ('country_in','country_not_in','residency_required');
    IF v_count >= 5 THEN
      RETURN QUERY SELECT
        'profile_country'::text,
        'Tell us which country you live in'::text,
        format('It resolves eligibility on %s opportunit%s. Only you can see it.', v_count, CASE WHEN v_count = 1 THEN 'y' ELSE 'ies' END),
        '/you/eligibility'::text,
        3;
    END IF;
  END IF;

  IF v_profile.user_id IS NOT NULL AND v_profile.student_status IS NULL THEN
    SELECT count(*)::int INTO v_count
      FROM eligibility_rules r2
      JOIN opportunities o ON o.id = r2.opportunity_id
     WHERE o.status = 'published' AND r2.rule_type = 'student_status_in';
    IF v_count >= 5 THEN
      RETURN QUERY SELECT
        'profile_student_status'::text,
        'Add your student status'::text,
        format('It resolves eligibility on %s opportunit%s.', v_count, CASE WHEN v_count = 1 THEN 'y' ELSE 'ies' END),
        '/you/eligibility'::text,
        3;
    END IF;
  END IF;

  IF v_profile.user_id IS NOT NULL AND v_profile.birth_year IS NULL THEN
    SELECT count(*)::int INTO v_count
      FROM eligibility_rules r2
      JOIN opportunities o ON o.id = r2.opportunity_id
     WHERE o.status = 'published' AND r2.rule_type = 'age_between';
    IF v_count >= 5 THEN
      RETURN QUERY SELECT
        'profile_birth_year'::text,
        'Add your birth year'::text,
        format('Age limits decide %s opportunit%s. The year is enough — we never ask for the date.', v_count, CASE WHEN v_count = 1 THEN 'y' ELSE 'ies' END),
        '/you/eligibility'::text,
        3;
    END IF;
  END IF;

  -- 4. Reminders going nowhere. Not one of §14.2's examples, but it is the same shape —
  --    a deterministic fact about the user's own state with one action — and it is the
  --    nudge NOTIFICATIONS.md §4 identifies as the one that fixes the binding constraint:
  --    "Telegram adoption is not a nice-to-have; it is the scaling plan."
  IF EXISTS (SELECT 1 FROM tracker_entries WHERE user_id = p_user_id)
     AND NOT EXISTS (
       SELECT 1 FROM notification_channels
        WHERE user_id = p_user_id AND channel = 'telegram' AND is_active AND verified_at IS NOT NULL)
  THEN
    SELECT count(*)::int INTO v_count FROM tracker_entries WHERE user_id = p_user_id;
    RETURN QUERY SELECT
      'link_telegram'::text,
      'Get your deadline reminders on Telegram'::text,
      format('You are tracking %s thing%s. Telegram is free to receive and does not use your email allowance.', v_count, CASE WHEN v_count = 1 THEN '' ELSE 's' END),
      '/you/notifications'::text,
      4;
  END IF;

  -- 5. Nothing tracked at all. The honest action for a new account, and it is a real one:
  --    every reminder this product sends is driven by the tracker (NOTIFICATIONS.md §6).
  IF NOT EXISTS (SELECT 1 FROM tracker_entries WHERE user_id = p_user_id) THEN
    RETURN QUERY SELECT
      'save_something'::text,
      'Save something to your tracker'::text,
      'Every reminder we send is driven by what you have saved. Nothing saved means nothing to remind you about.'::text,
      '/opportunities'::text,
      5;
  END IF;
END
$$;

/**
 * The same list, capped and ordered. §14.2's "max 5" enforced in one place.
 *
 * A separate function because next_actions returns rows as its rules fire, and capping
 * inside a plpgsql loop would mean each rule having to know how many had already fired —
 * which is how a cap gets broken by the next rule somebody adds.
 */
CREATE OR REPLACE FUNCTION next_actions_capped(p_user_id uuid, p_limit int DEFAULT 5)
RETURNS TABLE (kind text, headline text, reason text, href text, priority int)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT a.kind, a.headline, a.reason, a.href, a.priority
    FROM next_actions(p_user_id, p_limit) a
   ORDER BY a.priority
   LIMIT least(greatest(1, p_limit), 5)
$$;

REVOKE ALL ON FUNCTION your_window(uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION next_actions(uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION next_actions_capped(uuid, int) FROM PUBLIC;

-- Safe to grant: both refuse any user id but the caller's own.
GRANT EXECUTE ON FUNCTION your_window(uuid, int) TO authenticated;
GRANT EXECUTE ON FUNCTION next_actions(uuid, int) TO authenticated;
GRANT EXECUTE ON FUNCTION next_actions_capped(uuid, int) TO authenticated;
