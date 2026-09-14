-- 0009 Telegram account linking and the bot's data access (down)

DROP FUNCTION IF EXISTS digest_should_send(int, timestamptz, timestamptz, text);
DROP FUNCTION IF EXISTS bot_verdicts(text, text, uuid[]);
DROP FUNCTION IF EXISTS user_verdicts(uuid, uuid[]);
DROP FUNCTION IF EXISTS bot_tracker_summary(text, text);
DROP FUNCTION IF EXISTS bot_unlink(text, text);
DROP FUNCTION IF EXISTS bot_pause(text, text);
DROP FUNCTION IF EXISTS bot_redeem_link(text, text, text);
DROP FUNCTION IF EXISTS verify_service_secret(text, text);
DROP FUNCTION IF EXISTS jsonb_text_array(jsonb);

DROP TABLE IF EXISTS service_secrets;
DROP TABLE IF EXISTS telegram_link_codes;
