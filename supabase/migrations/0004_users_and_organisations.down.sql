-- 0004 users, profiles, eligibility profiles, organisations (down)
--
-- Teardown order is load-bearing here, and two dependencies are easy to miss:
--
--   1. `organisations_member_update` is a policy ON organisations that queries
--      organisation_members, so that policy must go before either table.
--   2. Every policy in this migration calls is_admin(), so the function can only
--      be dropped once they are all gone.
--
-- Done explicitly rather than with DROP ... CASCADE: a rollback that silently
-- removes more than it created is how a "reversible" migration loses data.

DROP POLICY IF EXISTS organisations_member_update ON organisations;
DROP POLICY IF EXISTS organisation_members_read ON organisation_members;

DROP TABLE IF EXISTS organisation_members;
DROP TABLE IF EXISTS organisations;
DROP TABLE IF EXISTS eligibility_profiles;
DROP TABLE IF EXISTS profiles;
DROP TABLE IF EXISTS users;

DROP FUNCTION IF EXISTS is_admin();

DROP TYPE IF EXISTS org_verification;
DROP TYPE IF EXISTS account_state;
DROP TYPE IF EXISTS profile_visibility;
