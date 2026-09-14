-- 0016 (down)

DROP TRIGGER IF EXISTS thread_messages_touch ON thread_messages;
DROP TRIGGER IF EXISTS blocks_cancel_everything ON blocks;
DROP TRIGGER IF EXISTS requests_validate ON collaboration_requests;
DROP TRIGGER IF EXISTS team_members_size ON team_members;
DROP TRIGGER IF EXISTS teams_add_owner ON teams;
DROP TRIGGER IF EXISTS teams_validate ON teams;
DROP TRIGGER IF EXISTS intents_set_expiry ON intents;

DROP FUNCTION IF EXISTS thread_messages_after_insert();
DROP FUNCTION IF EXISTS expire_collaboration();
DROP FUNCTION IF EXISTS handoff_identifiers(uuid);
DROP FUNCTION IF EXISTS accept_handoff(uuid, text);
DROP FUNCTION IF EXISTS decline_request(uuid);
DROP FUNCTION IF EXISTS accept_request(uuid);
DROP FUNCTION IF EXISTS room_state(uuid);
DROP FUNCTION IF EXISTS intent_count_public(uuid);
DROP FUNCTION IF EXISTS blocks_after_insert();
DROP FUNCTION IF EXISTS requests_before_insert();
DROP FUNCTION IF EXISTS team_members_after_change();
DROP FUNCTION IF EXISTS teams_after_insert();
DROP FUNCTION IF EXISTS teams_before_write();
DROP FUNCTION IF EXISTS intents_before_write();

-- Order matters, and not only for the foreign keys. The RLS policies on `intents` and
-- `teams` REFERENCE `blocks` — a policy creates a dependency on every table it reads —
-- so blocks cannot be dropped until those two are gone. Dropping it earlier fails with
-- "cannot drop table blocks because other objects depend on it", which is what this
-- ordering exists to prevent.
DROP TABLE IF EXISTS handoff_proposals;
DROP TABLE IF EXISTS thread_messages;
DROP TABLE IF EXISTS threads;
DROP TABLE IF EXISTS collaboration_requests;
DROP TABLE IF EXISTS team_members;
DROP TABLE IF EXISTS teams;
DROP TABLE IF EXISTS intents;
DROP TABLE IF EXISTS blocks;

DROP TYPE IF EXISTS request_state;
DROP TYPE IF EXISTS request_context;
DROP TYPE IF EXISTS team_state;
DROP TYPE IF EXISTS intent_stance;
