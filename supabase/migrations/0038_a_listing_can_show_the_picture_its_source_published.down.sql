-- Dropping this takes every listing's picture with it. The card is built to render a header
-- with or without one, so the page degrades to the state it shipped in rather than breaking —
-- which is why this rollback needs no accompanying page revert.
ALTER TABLE opportunities DROP COLUMN IF EXISTS image_url;
