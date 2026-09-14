-- The daily push cap was missing every delivery already in flight.
--
-- NOTIFICATIONS.md §1.2 `[PR]`: "at most 1 digest/day and 3 non-request transactional
-- messages/day". notif_pushes_today counted deliveries in state 'queued', 'deferred' and
-- 'sent' — and migration 0010 added a fourth state, 'claimed', for the moment between a
-- dispatcher picking a delivery up and reporting what happened to it.
--
-- So a delivery the dispatcher had claimed counted as nothing. The consequence is not
-- theoretical: the dispatcher runs every 15 minutes and claims in batches of up to 50, so
-- any notification enqueued while a run is in flight saw a cap one lower than the truth,
-- and a user could receive four or five pushes on a day the product promises three.
--
-- HOW IT WAS FOUND, because it is the more useful half. supabase/tests/notifications.sql
-- asserted the cap by counting one type's pushes and expecting 3. It passed all afternoon
-- and failed at 22:05 UTC. The reason: the fixture's other reminder is scheduled through
-- notif_quiet_adjusted, so before 19:00 UTC it was due, got claimed by an earlier step in
-- the suite, and vanished from the count — leaving a full cap for the type under test.
-- Inside the user's quiet hours it stayed 'queued', counted, and the cap bound one earlier.
-- The test was right to fail; it had been passing for the wrong reason, and the wrong reason
-- was a real defect in the cap.
--
-- 'failed' stays uncounted deliberately: a push that errored did not reach anybody, and
-- spending someone's daily allowance on a Telegram outage would be the wrong way round.
-- 'suppressed' stays uncounted for the same reason — it was decided against before sending.

CREATE OR REPLACE FUNCTION notif_pushes_today(p_user_id uuid, p_type notif_type DEFAULT NULL)
RETURNS int
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT count(*)::int
    FROM notification_deliveries d
    JOIN notifications n ON n.id = d.notification_id
   WHERE n.user_id = p_user_id
     AND d.channel <> 'in_app'
     -- Everything that has been sent or is on its way. 'claimed' is the in-flight state
     -- (migration 0010); leaving it out let the cap be exceeded by exactly the number of
     -- deliveries a dispatcher run happened to be holding.
     AND d.state IN ('queued','claimed','deferred','sent')
     AND n.created_at >= date_trunc('day', now())
     AND (p_type IS NULL OR n.type = p_type)
     AND (p_type IS NOT NULL OR NOT notif_cap_exempt(n.type))
     AND (p_type IS NOT NULL OR n.type <> 'digest')
$$;
