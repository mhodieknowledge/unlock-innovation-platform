-- Restores 0010's version of notif_pushes_today, which does not count in-flight
-- ('claimed') deliveries toward the daily push cap. Rolling this back reinstates the defect
-- described in the up migration: a user can receive more pushes in a day than
-- NOTIFICATIONS.md §1.2 promises, by the number of deliveries a dispatcher run is holding.

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
     AND d.state IN ('queued','deferred','sent')
     AND n.created_at >= date_trunc('day', now())
     AND (p_type IS NULL OR n.type = p_type)
     AND (p_type IS NOT NULL OR NOT notif_cap_exempt(n.type))
     AND (p_type IS NOT NULL OR n.type <> 'digest')
$$;
