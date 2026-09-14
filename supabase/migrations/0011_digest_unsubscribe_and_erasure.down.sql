-- 0011 (down)

DROP FUNCTION IF EXISTS purge_expired_data();
DROP FUNCTION IF EXISTS cancel_account_deletion();
DROP FUNCTION IF EXISTS request_account_deletion(boolean);
DROP FUNCTION IF EXISTS export_my_account();
DROP FUNCTION IF EXISTS digest_items(uuid);
DROP FUNCTION IF EXISTS redeem_unsubscribe_token(text, text);
DROP FUNCTION IF EXISTS describe_unsubscribe_token(text);
DROP FUNCTION IF EXISTS issue_unsubscribe_token(uuid, notif_type);

DROP TABLE IF EXISTS unsubscribe_tokens;
