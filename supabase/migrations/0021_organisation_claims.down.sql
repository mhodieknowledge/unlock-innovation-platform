-- Rolls 0021 back.
--
-- The UPDATE policy and the re-review trigger go before the table they are attached to
-- exists in the other direction; order here is reverse of creation, and the policy on
-- `opportunities` must be dropped explicitly because that table itself survives.

DROP POLICY IF EXISTS opportunities_org_edit ON opportunities;
DROP TRIGGER IF EXISTS opportunities_org_edit ON opportunities;
DROP FUNCTION IF EXISTS opportunities_org_edit_review();

DROP FUNCTION IF EXISTS submit_opportunity_public(text, text, text, text, text, text, text, boolean);
DROP FUNCTION IF EXISTS org_opportunities(text);
DROP FUNCTION IF EXISTS org_submit_opportunity(
  text, text, text, text, text, text, timestamptz, deadline_precision, cost_kind,
  eligibility_scope, char(2)[], boolean, smallint, smallint);
DROP FUNCTION IF EXISTS review_org_claim(uuid, boolean, text);
DROP FUNCTION IF EXISTS my_org_claims();
DROP FUNCTION IF EXISTS confirm_org_claim(text);
DROP FUNCTION IF EXISTS start_org_claim(text, text, text);
DROP FUNCTION IF EXISTS email_domain(text);
DROP FUNCTION IF EXISTS normalise_domain(text);

-- Restores 0010's claim_deliveries, which addresses every email to the account's own
-- address and ignores payload.email_override.
CREATE OR REPLACE FUNCTION claim_deliveries(p_channel notif_channel, p_limit int DEFAULT 50)
RETURNS TABLE (
  delivery_id uuid,
  notification_id uuid,
  user_id uuid,
  type notif_type,
  payload jsonb,
  reason text,
  priority smallint,
  address text,
  timezone text,
  low_data_mode boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cap int := channel_daily_cap(p_channel);
  v_sent int;
  v_remaining int;
  r record;
  v_send boolean;
  v_downgrade_id uuid;
BEGIN
  INSERT INTO send_budget (day, channel, cap)
  VALUES (current_date, p_channel, v_cap)
  ON CONFLICT (day, channel) DO NOTHING;

  SELECT sent INTO v_sent FROM send_budget
   WHERE day = current_date AND channel = p_channel FOR UPDATE;
  v_remaining := v_cap - v_sent;

  FOR r IN
    SELECT d.id, d.notification_id, d.deferrals, n.user_id, n.type, n.payload,
           n.reason, n.priority
      FROM notification_deliveries d
      JOIN notifications n ON n.id = d.notification_id
     WHERE d.channel = p_channel
       AND d.state IN ('queued','deferred')
       AND d.scheduled_for <= now()
     ORDER BY n.priority ASC, d.scheduled_for ASC
     LIMIT p_limit
     FOR UPDATE OF d SKIP LOCKED
  LOOP
    -- §6 `[PR]`: re-check at send time, not schedule time.
    IF r.type = 'deadline_reminder' THEN
      IF NOT EXISTS (
        SELECT 1 FROM tracker_entries t
          JOIN opportunities o ON o.id = t.opportunity_id
         WHERE t.user_id = r.user_id
           AND o.id = (r.payload->>'opportunity_id')::uuid
           AND o.status = 'published'
           AND t.state IN ('saved','planning_to_apply','applied','submitted','participating')
      ) THEN
        UPDATE notification_deliveries
           SET state = 'suppressed',
               error = 'cancelled at send time: opportunity or tracker state changed'
         WHERE id = r.id;
        CONTINUE;
      END IF;
    END IF;

    v_send := CASE
      WHEN r.priority <= 2 THEN true
      WHEN r.priority = 3 THEN v_remaining > 40
      ELSE v_remaining > 120
    END;

    IF v_send THEN
      v_remaining := v_remaining - 1;
      UPDATE notification_deliveries SET state = 'claimed' WHERE id = r.id;
      RETURN QUERY
        SELECT r.id, r.notification_id, r.user_id, r.type, r.payload, r.reason, r.priority,
               CASE WHEN p_channel = 'email' THEN u.email::text
                    ELSE c.address END,
               u.timezone, u.low_data_mode
          FROM users u
          LEFT JOIN notification_channels c
                 ON c.user_id = u.id AND c.channel = p_channel
         WHERE u.id = r.user_id;
    ELSIF r.deferrals >= 2 THEN
      -- §4: "Downgrade is visible, not silent."
      UPDATE notification_deliveries
         SET state = 'suppressed', error = 'budget: downgraded to in-app after 2 deferrals'
       WHERE id = r.id;

      -- §4: "This converts a capacity limit into the exact nudge that fixes it."
      INSERT INTO notifications (user_id, type, payload, reason, priority)
      VALUES (r.user_id, 'system',
              jsonb_build_object('kind','budget_downgrade','notification_id', r.notification_id,
                                 'downgraded_type', r.type),
              CASE WHEN r.type = 'digest'
                THEN 'Your digest is waiting — link Telegram to get it delivered.'
                ELSE 'We could not email this one today. Link Telegram and messages arrive straight away.'
              END, 5)
      RETURNING id INTO v_downgrade_id;

      INSERT INTO notification_deliveries (notification_id, channel, state, sent_at)
      VALUES (v_downgrade_id, 'in_app', 'sent', now());
    ELSE
      UPDATE notification_deliveries
         SET state = 'deferred',
             deferrals = deferrals + 1,
             scheduled_for = now() + interval '24 hours'
       WHERE id = r.id;
    END IF;
  END LOOP;

  -- Record exhaustion the moment it happens, for §4 rule 5's two-day test.
  IF v_remaining <= 0 THEN
    UPDATE send_budget SET exhausted_at = coalesce(exhausted_at, now())
     WHERE day = current_date AND channel = p_channel;
  END IF;
END
$$;

DROP POLICY IF EXISTS organisation_claims_admin ON organisation_claims;
DROP TABLE IF EXISTS organisation_claims;
