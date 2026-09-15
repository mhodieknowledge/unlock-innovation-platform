-- 0023 the public builder profile
--
-- PRODUCT_SPEC.md §16, UX_FLOWS.md §8.1–8.2, SEO.md §1.
--
-- The gap this closes: §16.1's two-layer model has existed in the schema since 0004 — a
-- private `eligibility_profiles` and a public `profiles` — and the private half has had a
-- page since Phase 2. The public half had no read path and no page at all, which meant
-- `/b/[handle]` (UX §8.2, and a row in SEO.md §1's indexing table) did not exist, the three
-- visibility levels in §16.2 could not be chosen, and `discoverable_in_rooms` was a value
-- nothing could act on.
--
-- WHY A FUNCTION AND NOT A POLICY. 0004's comment says the room half of the read rule would
-- arrive "in the migration that creates `intents`". It did not, and adding it now as a policy
-- would put a join against `intents` on EVERY read of `profiles` — including the room reads
-- that already have their own rule, and the matcher's bulk reads. `users.display_name` is not
-- readable by anyone but its owner either (`users_self_read`), so a policy on `profiles` alone
-- could never render a profile page regardless. One SECURITY DEFINER function returns exactly
-- the fields a profile page shows, to exactly the people entitled to see them, and nothing
-- else in the database changes.

/**
 * Handle hygiene, as a trigger rather than a CHECK constraint.
 *
 * A handle appears in a URL and, on a page carrying somebody's name, is an identity claim. Two
 * jobs, and only one of them a constraint can do: normalising to lower case (a constraint can
 * refuse `Builder`, it cannot accept it as `builder`) and refusing a handle that impersonates
 * this product or its staff.
 *
 * The reserved list holds role words and the product's own route names. It deliberately does
 * NOT hold the brand name: PRODUCT_SPEC.md §1 makes that a configuration token that lives in
 * exactly one module, and a copy of it in a migration would be the drift that module exists to
 * prevent. Brand-name squatting is a moderation matter, and `reports` already has a `profile`
 * subject type for it.
 */
CREATE OR REPLACE FUNCTION users_handle_hygiene()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_handle text;
  v_reserved text[] := ARRAY[
    -- role claims
    'admin','administrator','moderator','mod','staff','support','help','official','team',
    'root','system','security','billing','abuse','privacy','legal','press','info','contact',
    -- every first path segment this product routes, so a handle can never read as one
    'api','auth','b','admin','opportunities','countries','categories','organisations',
    'projects','threads','requests','tracker','you','signin','signout','submit','report',
    'privacy','terms','content-policy','anti-scam','verification','bot','changelog',
    'feeds','sitemap','sitemaps','offline','low-data','manifest','unsubscribe','new','edit'
  ];
BEGIN
  IF NEW.handle IS NULL THEN
    RETURN NEW;
  END IF;

  v_handle := lower(btrim(NEW.handle::text));

  IF v_handle = '' THEN
    NEW.handle := NULL;
    RETURN NEW;
  END IF;

  -- 3 to 30 characters, letters/digits/hyphen/underscore, never starting or ending with a
  -- separator. Short enough to type, long enough not to force numbers onto people.
  IF v_handle !~ '^[a-z0-9](?:[a-z0-9_-]{1,28})[a-z0-9]$' THEN
    RAISE EXCEPTION 'a handle is 3 to 30 characters: letters, numbers, hyphens and underscores, starting and ending with a letter or number';
  END IF;

  IF v_handle = ANY (v_reserved) THEN
    RAISE EXCEPTION 'that handle is reserved';
  END IF;

  NEW.handle := v_handle;
  RETURN NEW;
END
$$;

CREATE TRIGGER users_handle_hygiene
  BEFORE INSERT OR UPDATE OF handle ON users
  FOR EACH ROW EXECUTE FUNCTION users_handle_hygiene();

/**
 * One public profile, by handle. UX_FLOWS.md §8.2.
 *
 * The four states in §8.2 are all expressed as "a row, or nothing":
 *
 *   public                 — anyone, signed in or not.
 *   discoverable_in_rooms  — only a viewer who shares an ACTIVE intent with them, which is
 *                            the same condition `room_builders` uses. Everyone else gets
 *                            nothing, and the page answers 404 rather than "this is private":
 *                            the existence of a profile at a handle is itself information.
 *   private                — nothing.
 *   restricted/suspended   — nothing. §22.1's read-only state is about writing; a suspended
 *                            account's public page comes down, which is the point of it.
 *
 * `shared_context` is returned, not inferred by the page: §8.2 allows a contextual request
 * "only from a shared context", and the page must not have to run a second query against
 * tables it cannot read to find out. The SLUG of that context comes back with it — the request
 * composer needs the opportunity as well as the person, and a button that carried only the
 * person would land on a form that cannot tell what it is for. Where several are shared, the
 * soonest to close wins, which is the one the two of them need to talk about first.
 *
 * `indexable` is returned so the page can set `noindex`. SEO.md §1: "A user who fills in a
 * profile has not consented to being found on Google" — two separate opt-ins, and the second
 * one defaults off in the column definition.
 */
CREATE OR REPLACE FUNCTION public_profile(p_handle text)
RETURNS TABLE (
  user_id uuid,
  handle text,
  display_name text,
  visibility profile_visibility,
  indexable boolean,
  headline text,
  bio text,
  country_iso2 char(2),
  country_name text,
  country_slug text,
  city text,
  github_url text,
  portfolio_url text,
  other_url text,
  open_to text[],
  availability_hours_per_week smallint,
  shared_context boolean,
  shared_opportunity_slug text,
  updated_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me uuid := auth.uid();
  v_handle text := lower(btrim(coalesce(p_handle, '')));
BEGIN
  IF v_handle = '' THEN RETURN; END IF;

  RETURN QUERY
  SELECT u.id,
         u.handle::text,
         u.display_name,
         p.visibility,
         p.indexable,
         p.headline,
         p.bio,
         p.country_iso2,
         c.name,
         c.slug,
         p.city,
         p.github_url,
         p.portfolio_url,
         p.other_url,
         p.open_to,
         p.availability_hours_per_week,
         v_shared.slug IS NOT NULL,
         v_shared.slug,
         p.updated_at
    FROM users u
    JOIN profiles p ON p.user_id = u.id
    LEFT JOIN countries c ON c.iso2 = p.country_iso2
    CROSS JOIN LATERAL (
      SELECT (
               SELECT o.slug
                 FROM intents mine
                 JOIN intents theirs ON theirs.opportunity_id = mine.opportunity_id
                 JOIN opportunities o ON o.id = mine.opportunity_id
                WHERE v_me IS NOT NULL
                  AND v_me <> u.id
                  AND mine.user_id = v_me
                  AND theirs.user_id = u.id
                  AND mine.withdrawn_at IS NULL AND mine.expires_at > now()
                  AND theirs.withdrawn_at IS NULL AND theirs.expires_at > now()
                  AND o.status = 'published'
                ORDER BY o.deadline_at NULLS LAST
                LIMIT 1
             ) AS slug
    ) v_shared
   WHERE u.handle = v_handle::citext
     AND u.deleted_at IS NULL
     AND u.account_state = 'active'
     AND (
       p.visibility = 'public'
       OR p.user_id = v_me
       OR (p.visibility = 'discoverable_in_rooms' AND v_shared.slug IS NOT NULL)
     );
END
$$;

-- Readable by a signed-out visitor, because a public profile is public. The function is the
-- only thing that decides what "public" means here.
GRANT EXECUTE ON FUNCTION public_profile(text) TO anon, authenticated;

COMMENT ON FUNCTION public_profile(text) IS
  'One public builder profile by handle, or nothing. UX_FLOWS.md §8.2. The only read path to the public profile layer: users.display_name is owner-only under RLS.';
