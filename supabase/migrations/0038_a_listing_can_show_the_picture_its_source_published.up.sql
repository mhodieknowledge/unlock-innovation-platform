-- 0038 a listing can show the picture its source published
--
-- The board has never carried a picture of an individual opportunity, and the reason was good:
-- a photograph chosen BY US to represent someone else's hackathon is a claim we cannot check,
-- on a product whose whole position is that it quotes the organiser rather than paraphrasing
-- them. Category-level marketing photography was tried instead and removed, because a stock
-- image of "hackathons" is decoration standing where a fact should be.
--
-- An `og:image` is a different object, and that is what this column holds. It is the picture
-- the ORGANISER attached to their own page, published for the express purpose of being shown
-- when that page is linked. Rendering it beside a link to that page is the use it was made
-- for. We choose nothing and invent nothing.
--
-- WHY A URL AND NOT BYTES. FREE_INFRASTRUCTURE.md §3.9 rules out an image transformation
-- service, and the object store it names (R2) has no binding in this app yet. So the row
-- records where the picture is, and the web tier fetches it through an endpoint on our own
-- origin — which is required regardless, because the CSP is `img-src 'self' data:` and will
-- stay that way. Widening it to allow arbitrary remote origins would hand every source's CDN
-- a request from every reader, which ANALYTICS.md's no-third-party-tracking position does not
-- permit.
--
-- THE CHECK IS LOAD-BEARING, NOT DECORATIVE. Anything in this column is later fetched by our
-- own server, which makes a bad value an SSRF vector rather than a broken picture. The
-- constraint is the last line of a defence whose first line is packages/ingest/src/images.mjs
-- (`safeImageUrl`, which also refuses private hosts, credentials and odd ports) and whose
-- third is the serving route re-validating what it reads. Three checks for one value is
-- deliberate: the pipeline that wrote a row ran under rules that may since have changed.
--
-- NULL IS THE NORMAL CASE and the card is built for it. Most sources publish no `og:image`,
-- and a grid where some cards have photographs and others do not is the exact defect this
-- redesign removed twice already — so the card renders a header of the same size either way,
-- and the picture is what fills it when there is one.

ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS image_url text
    CHECK (image_url IS NULL OR (image_url ~ '^https://' AND char_length(image_url) <= 1024));

COMMENT ON COLUMN opportunities.image_url IS
  'The `og:image` the source published on its own page, https only. Never a picture chosen by us. Fetched only through this app''s own image route, because the CSP allows no remote image origins. Written by scripts/ingest.mjs via packages/ingest/src/images.mjs.';
