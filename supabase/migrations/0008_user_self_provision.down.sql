-- 0008 self-provisioning for a newly authenticated user (down)

DROP TRIGGER IF EXISTS eligibility_profiles_completeness ON eligibility_profiles;
DROP FUNCTION IF EXISTS eligibility_profiles_set_completeness();
DROP FUNCTION IF EXISTS eligibility_completeness(uuid);

DROP POLICY IF EXISTS notif_settings_insert_self ON user_notification_settings;
DROP POLICY IF EXISTS eligibility_profiles_insert_self ON eligibility_profiles;
DROP POLICY IF EXISTS profiles_insert_self ON profiles;
DROP POLICY IF EXISTS users_insert_self ON users;
