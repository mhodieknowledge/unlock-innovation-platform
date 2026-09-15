-- Rolls 0023 back. Every object is new in this migration, so the rollback is drops only.
--
-- Nothing is restored: 0004's `profiles_public_read` policy is untouched by the up migration
-- (see its header for why the room rule went into a function instead), so there is no earlier
-- definition to put back.

DROP FUNCTION IF EXISTS public_profile(text);

DROP TRIGGER IF EXISTS users_handle_hygiene ON users;
DROP FUNCTION IF EXISTS users_handle_hygiene();
