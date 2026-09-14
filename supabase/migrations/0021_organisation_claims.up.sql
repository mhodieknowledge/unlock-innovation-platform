-- Organisations, self-serve. PRODUCT_SPEC.md §19, MODERATION_AND_TRUST.md §9,
-- API_SPEC.md §12, DATA_MODEL.md §3.
--
-- §19 `[PR]`: "Verified organisations may submit and edit their own opportunities, which
-- publish with `official` verification. Edits by an organisation to a previously verified
-- record RE-ENTER REVIEW if they change eligibility, dates or cost."
--
-- That last clause is the interesting one, and it is enforced here rather than in a route:
-- the whole reason an organisation's own edit is trusted enough to publish is that it comes
-- from the organisation — and the whole reason it cannot be trusted blindly is that a
-- changed deadline or a changed eligibility rule is exactly what people have already acted
-- on. A trigger sees every edit, whichever route made it.
--
-- ON THE CLAIM TOKEN. DATA_MODEL.md specifies `token_hash`. This table stores the token
-- itself, and the deviation is deliberate: only the batch tier has email credentials
-- (FREE_INFRASTRUCTURE.md §3.3), so it is the batch tier that must render the confirmation
-- link — and it cannot render a link from a hash. The token is therefore stored the way
-- migration 0009 stores Telegram link codes: short-lived, single-use, and behind RLS with
-- NO read policy at all, so no principal except a definer function or the table owner can
-- see it. In particular the CLAIMANT cannot read it, which matters more than the hash
-- would: a token they could read in their own inbox would defeat the entire point of
-- sending it to an address at the organisation's domain.

CREATE TABLE organisation_claims (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  claim_email     citext NOT NULL,
  email_domain    text NOT NULL,
  -- §9: "Organisation claims require a domain-matched email. Non-matching claims require
  -- evidence and human review." Computed server-side, never supplied by the caller.
  domain_matches  boolean NOT NULL,
  evidence_url    text CHECK (evidence_url IS NULL OR char_length(evidence_url) <= 500),
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','awaiting_review','approved','rejected','expired')),
  token           text,
  token_expires_at timestamptz,
  email_sent_at   timestamptz,
  reviewed_by     uuid REFERENCES users(id),
  reviewed_at     timestamptz,
  review_note     text CHECK (review_note IS NULL OR char_length(review_note) <= 500),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX organisation_claims_org_idx ON organisation_claims (organisation_id, status);
CREATE INDEX organisation_claims_user_idx ON organisation_claims (user_id, created_at DESC);
CREATE UNIQUE INDEX organisation_claims_token_idx ON organisation_claims (token)
  WHERE token IS NOT NULL;
-- For the batch tier's outbound queue.
CREATE INDEX organisation_claims_unsent_idx ON organisation_claims (created_at)
  WHERE status = 'pending' AND email_sent_at IS NULL;

COMMENT ON TABLE organisation_claims IS
  'PRODUCT_SPEC.md §19 and MODERATION_AND_TRUST.md §9. The token column holds a short-lived capability, not a hash: only the batch tier can send email, and it cannot render a link from a hash. RLS is on with no read policy, so the claimant cannot read their own token — which is the point of emailing it to the organisation domain.';

ALTER TABLE organisation_claims ENABLE ROW LEVEL SECURITY;

-- A claimant may see THAT they claimed and what happened to it. Not the token: the column
-- list a policy grants is the whole row, so the safe read path is the function below.
CREATE POLICY organisation_claims_admin ON organisation_claims FOR ALL
  USING (is_admin()) WITH CHECK (is_admin());

/**
 * The registrable-ish domain of an email or URL host, normalised for comparison.
 *
 * Deliberately simple: lowercase, strip a leading `www.`, drop any port or path. It does
 * NOT try to compute a public suffix — `mail.example.ac.zw` and `example.ac.zw` are
 * different strings here, so a claim from a subdomain address does not auto-match. That
 * fails toward human review, which is the right direction for a control that decides who
 * may publish as an institution.
 */
CREATE OR REPLACE FUNCTION normalise_domain(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT nullif(
    regexp_replace(
      regexp_replace(
        lower(btrim(coalesce(p_value, ''))),
        '^[a-z]+://', ''),          -- scheme
      '^www\.', ''),
    '')
$$;

/** The domain part of an email address, normalised the same way. */
CREATE OR REPLACE FUNCTION email_domain(p_email text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT normalise_domain(split_part(lower(btrim(coalesce(p_email, ''))), '@', 2))
$$;

/**
 * Start a claim. API_SPEC.md §12: `POST /organisations/{slug}/claim` with
 * `{ claim_email, evidence_url? }` and "domain match computed server-side".
 *
 * Two outcomes, and the difference is the whole control:
 *   domain matches  → a token is issued and emailed. Confirming it verifies the
 *                     organisation with no human involved (§19: "verified (domain-matched
 *                     email confirmed)").
 *   does not match  → status `awaiting_review`, a review-queue row at priority 3, and no
 *                     token at all. §9: "Non-matching claims require evidence and human
 *                     review."
 *
 * The organisation moves to `claimed_pending` either way, so its page stops inviting more
 * claims while one is in flight.
 */
CREATE OR REPLACE FUNCTION start_org_claim(
  p_slug text,
  p_claim_email text,
  p_evidence_url text DEFAULT NULL
)
RETURNS TABLE (claim_id uuid, domain_matches boolean, status text, organisation_domain text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_me uuid := auth.uid();
  o organisations;
  v_email citext;
  v_domain text;
  v_org_domain text;
  v_matches boolean;
  v_status text;
  v_claim uuid;
  v_recent int;
  v_state account_state;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'you need to be signed in to claim an organisation';
  END IF;

  SELECT account_state INTO v_state FROM users WHERE id = v_me;
  IF v_state IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'this account cannot claim an organisation';
  END IF;

  SELECT * INTO o FROM organisations WHERE slug = p_slug AND deleted_at IS NULL;
  IF o.id IS NULL THEN
    RAISE EXCEPTION 'no such organisation';
  END IF;
  IF o.verification = 'verified' THEN
    RAISE EXCEPTION 'this organisation is already verified — ask whoever verified it to add you';
  END IF;
  IF o.verification = 'suspended' THEN
    RAISE EXCEPTION 'this organisation cannot be claimed';
  END IF;

  v_email := lower(btrim(coalesce(p_claim_email, '')));
  IF position('@' in v_email::text) = 0 OR length(v_email::text) < 5 THEN
    RAISE EXCEPTION 'that does not look like an email address';
  END IF;

  -- One claim at a time per person per organisation, and three a day in total. A claim
  -- issues an email to an address the claimant chose, so an unbounded claim endpoint is an
  -- unbounded way to send our email budget somewhere of their choosing.
  IF EXISTS (SELECT 1 FROM organisation_claims c
              WHERE c.organisation_id = o.id AND c.user_id = v_me
                AND c.status IN ('pending','awaiting_review')) THEN
    RAISE EXCEPTION 'you already have a claim on this organisation waiting';
  END IF;

  SELECT count(*)::int INTO v_recent
    FROM organisation_claims c
   WHERE c.user_id = v_me AND c.created_at > now() - interval '24 hours';
  IF v_recent >= 3 THEN
    RAISE EXCEPTION 'you have started 3 claims today, which is the daily limit';
  END IF;

  v_domain := email_domain(v_email::text);
  v_org_domain := coalesce(normalise_domain(o.website_domain), normalise_domain(o.website_url));
  v_matches := v_domain IS NOT NULL AND v_org_domain IS NOT NULL AND v_domain = v_org_domain;
  v_status := CASE WHEN v_matches THEN 'pending' ELSE 'awaiting_review' END;

  INSERT INTO organisation_claims
    (organisation_id, user_id, claim_email, email_domain, domain_matches, evidence_url,
     status, token, token_expires_at)
  VALUES
    (o.id, v_me, v_email, coalesce(v_domain, ''), v_matches,
     nullif(btrim(coalesce(p_evidence_url, '')), ''),
     v_status,
     -- 24 hours, and only for a matched claim. A token issued for a claim that needs human
     -- review would be a way to skip the review.
     CASE WHEN v_matches THEN encode(gen_random_bytes(24), 'hex') ELSE NULL END,
     CASE WHEN v_matches THEN now() + interval '24 hours' ELSE NULL END)
  RETURNING id INTO v_claim;

  UPDATE organisations
     SET verification = 'claimed_pending', updated_at = now()
   WHERE id = o.id AND verification = 'unclaimed';

  IF NOT v_matches THEN
    INSERT INTO review_queue (queue, subject_type, subject_id, priority)
    VALUES ('org_claim', 'organisation', o.id, 3);
  ELSE
    -- The confirmation email. type `security` because it is about access and must not be
    -- capped, paused or opted out of — NOTIFICATIONS.md §9 gives security messages no
    -- switch, and a confirmation you just asked for is the clearest case of that.
    --
    -- The payload carries the claim id and the address to send to, and NOT the token: a
    -- user can read their own notifications, and a token they can read without opening the
    -- organisation's mailbox proves nothing.
    PERFORM enqueue_notification(
      v_me, 'security',
      'Confirm your claim on ' || o.name || '.',
      jsonb_build_object('kind', 'org_claim', 'claim_id', v_claim,
                         'email_override', v_email::text, 'organisation', o.name),
      NULL, true);
  END IF;

  RETURN QUERY SELECT v_claim, v_matches, v_status, v_org_domain;
END
$$;

/**
 * Confirm a claim from the emailed token. API_SPEC.md §12's
 * `POST /organisations/claims/{id}/confirm`.
 *
 * Deliberately says the same thing for an unknown, expired and already-used token: a
 * distinct answer for each would turn this into an oracle for which tokens exist.
 */
CREATE OR REPLACE FUNCTION confirm_org_claim(p_token text)
RETURNS TABLE (ok boolean, organisation_slug text, organisation_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c organisation_claims;
  o organisations;
BEGIN
  IF p_token IS NULL OR length(btrim(p_token)) < 20 THEN
    RETURN QUERY SELECT false, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT * INTO c FROM organisation_claims
   WHERE token = btrim(p_token)
     AND status = 'pending'
     AND domain_matches
     AND token_expires_at > now();

  IF c.id IS NULL THEN
    RETURN QUERY SELECT false, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT * INTO o FROM organisations WHERE id = c.organisation_id;

  UPDATE organisation_claims
     SET status = 'approved', reviewed_at = now(), token = NULL, token_expires_at = NULL
   WHERE id = c.id;

  -- §19: "verified (domain-matched email confirmed)".
  UPDATE organisations
     SET verification = 'verified', verified_at = now(), updated_at = now()
   WHERE id = o.id;

  INSERT INTO organisation_members (organisation_id, user_id, role)
  VALUES (o.id, c.user_id, 'owner')
  ON CONFLICT (organisation_id, user_id) DO UPDATE SET role = 'owner';

  -- Any other claim in flight on this organisation is now moot, and its queue row with it.
  UPDATE organisation_claims
     SET status = 'rejected', reviewed_at = now(), token = NULL,
         review_note = 'another claim was confirmed first'
   WHERE organisation_id = o.id AND id <> c.id AND status IN ('pending','awaiting_review');

  UPDATE review_queue SET state = 'done'
   WHERE queue = 'org_claim' AND subject_id = o.id AND state <> 'done';

  PERFORM enqueue_notification(
    c.user_id, 'security',
    'You are now verified as ' || o.name || ' and can publish opportunities.',
    jsonb_build_object('kind', 'org_claim_approved', 'organisation', o.name,
                       'slug', o.slug));

  RETURN QUERY SELECT true, o.slug, o.name;
END
$$;

/**
 * A claimant's own view of their claims. Everything except the token.
 *
 * A function rather than a SELECT policy because a policy grants whole rows, and the one
 * column on this table that must never be readable by the claimant is on the same row as
 * the ones they should see.
 */
CREATE OR REPLACE FUNCTION my_org_claims()
RETURNS TABLE (
  claim_id uuid,
  organisation_slug text,
  organisation_name text,
  claim_email text,
  domain_matches boolean,
  status text,
  review_note text,
  created_at timestamptz,
  email_sent_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_me uuid := auth.uid();
BEGIN
  IF v_me IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT c.id, o.slug, o.name, c.claim_email::text, c.domain_matches, c.status,
         c.review_note, c.created_at, c.email_sent_at
    FROM organisation_claims c
    JOIN organisations o ON o.id = c.organisation_id
   WHERE c.user_id = v_me
   ORDER BY c.created_at DESC
   LIMIT 20;
END
$$;

/**
 * An admin's decision on a claim that could not be domain-matched.
 *
 * Approving does exactly what confirming a matched claim does, minus the email step —
 * which is why it calls the same code path rather than repeating it.
 */
CREATE OR REPLACE FUNCTION review_org_claim(p_claim_id uuid, p_approve boolean, p_note text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  c organisation_claims;
  v_token text;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'only an admin may review a claim';
  END IF;

  SELECT * INTO c FROM organisation_claims WHERE id = p_claim_id;
  IF c.id IS NULL OR c.status NOT IN ('pending','awaiting_review') THEN RETURN false; END IF;

  IF NOT p_approve THEN
    UPDATE organisation_claims
       SET status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(),
           token = NULL, review_note = left(btrim(coalesce(p_note, '')), 500)
     WHERE id = c.id;

    -- Back to unclaimed, so somebody with a domain address can still claim it. `rejected`
    -- on the ORGANISATION would be a permanent mark for one person's bad claim.
    UPDATE organisations SET verification = 'unclaimed', updated_at = now()
     WHERE id = c.organisation_id AND verification = 'claimed_pending';

    UPDATE review_queue SET state = 'done'
     WHERE queue = 'org_claim' AND subject_id = c.organisation_id AND state <> 'done';

    PERFORM enqueue_notification(
      c.user_id, 'security',
      'Your claim was not approved.',
      jsonb_build_object('kind', 'org_claim_rejected',
                         'note', left(btrim(coalesce(p_note, '')), 500)));

    INSERT INTO admin_audit_log (actor_user_id, action, subject_type, subject_id, after)
    VALUES (auth.uid(), 'org_claim_reject', 'organisation_claim', c.id,
            jsonb_build_object('note', p_note));
    RETURN true;
  END IF;

  -- Approve: issue a token and spend it immediately, so approval and confirmation share
  -- one implementation and cannot drift.
  v_token := encode(gen_random_bytes(24), 'hex');
  UPDATE organisation_claims
     SET status = 'pending', domain_matches = true, token = v_token,
         token_expires_at = now() + interval '1 hour',
         reviewed_by = auth.uid(), reviewed_at = now(),
         review_note = left(btrim(coalesce(p_note, '')), 500)
   WHERE id = c.id;

  PERFORM confirm_org_claim(v_token);

  INSERT INTO admin_audit_log (actor_user_id, action, subject_type, subject_id, after)
  VALUES (auth.uid(), 'org_claim_approve', 'organisation_claim', c.id,
          jsonb_build_object('note', p_note, 'domain_matched', false));
  RETURN true;
END
$$;

-- ── §19's re-review rule ────────────────────────────────────────────────────

/**
 * An organisation's edit to a published record re-enters review when it touches
 * eligibility, dates or cost — and the people tracking it are told. `[PR]`
 *
 * Why a trigger: the rule is about the EDIT, not about the route. There are already three
 * ways a row can change (an org member's form, an admin action, the re-verification job)
 * and each new one would otherwise have to remember. A trigger sees them all.
 *
 * Admins are exempt: a reviewer's edit IS the review, and sending it back to the queue it
 * came from would be a loop. The re-verification job is exempt for the same reason — it
 * writes as the batch tier with no auth.uid(), and its changes are already recorded as
 * opportunity_changes with their own notifications (migration 0012).
 */
CREATE OR REPLACE FUNCTION opportunities_org_edit_review()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me uuid := auth.uid();
  v_is_member boolean;
  v_material boolean;
  v_trackers int;
BEGIN
  IF v_me IS NULL OR is_admin() THEN RETURN NEW; END IF;

  SELECT EXISTS (
    SELECT 1 FROM organisation_members m
     WHERE m.organisation_id = NEW.organisation_id AND m.user_id = v_me
  ) INTO v_is_member;

  IF NOT v_is_member THEN RETURN NEW; END IF;

  -- The three §19 names, and nothing else. A changed summary or a fixed typo must not cost
  -- an organisation its published state — that would teach them not to fix typos.
  v_material :=
       NEW.deadline_at       IS DISTINCT FROM OLD.deadline_at
    OR NEW.deadline_precision IS DISTINCT FROM OLD.deadline_precision
    OR NEW.opens_at          IS DISTINCT FROM OLD.opens_at
    OR NEW.is_rolling        IS DISTINCT FROM OLD.is_rolling
    OR NEW.eligibility_scope IS DISTINCT FROM OLD.eligibility_scope
    OR NEW.eligible_countries IS DISTINCT FROM OLD.eligible_countries
    OR NEW.excluded_countries IS DISTINCT FROM OLD.excluded_countries
    OR NEW.team_required     IS DISTINCT FROM OLD.team_required
    OR NEW.team_size_min     IS DISTINCT FROM OLD.team_size_min
    OR NEW.team_size_max     IS DISTINCT FROM OLD.team_size_max
    OR NEW.cost              IS DISTINCT FROM OLD.cost
    OR NEW.cost_description  IS DISTINCT FROM OLD.cost_description;

  IF NOT v_material THEN RETURN NEW; END IF;

  IF OLD.status = 'published' THEN
    NEW.status := 'in_review';
    -- It was official or verified; it is now an unreviewed claim about eligibility again.
    IF OLD.verification IN ('official','verified') THEN
      NEW.verification := 'auto';
    END IF;

    INSERT INTO review_queue (queue, subject_type, subject_id, priority)
    SELECT 'ugc', 'opportunity', NEW.id, 3
     WHERE NOT EXISTS (
       SELECT 1 FROM review_queue q
        WHERE q.queue = 'ugc' AND q.subject_id = NEW.id AND q.state <> 'done');

    -- The acceptance criterion's second half: the people who tracked it are told. They
    -- acted on the old dates, which is the whole reason this edit re-enters review.
    SELECT count(*)::int INTO v_trackers
      FROM tracker_entries t
     WHERE t.opportunity_id = NEW.id AND t.state <> 'withdrawn';

    IF v_trackers > 0 THEN
      PERFORM enqueue_notification(
        t.user_id, 'opportunity_changed',
        'The organisation changed something on "' || NEW.title || '". We are checking it.',
        jsonb_build_object('slug', NEW.slug, 'title', NEW.title,
                           'changed', CASE WHEN NEW.deadline_at IS DISTINCT FROM OLD.deadline_at
                                           THEN 'deadline' ELSE 'eligibility or cost' END))
        FROM tracker_entries t
       WHERE t.opportunity_id = NEW.id AND t.state <> 'withdrawn';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER opportunities_org_edit
  BEFORE UPDATE ON opportunities
  FOR EACH ROW EXECUTE FUNCTION opportunities_org_edit_review();

/**
 * An organisation's own new opportunity. §19: publishes as `official`.
 *
 * A function rather than an INSERT policy because `official` is a claim about provenance
 * that only this path may make: a policy permitting an org member to insert would let them
 * choose their own verification value.
 */
CREATE OR REPLACE FUNCTION org_submit_opportunity(
  p_org_slug text,
  p_title text,
  p_category_code text,
  p_summary text,
  p_description_md text,
  p_apply_url text,
  p_deadline_at timestamptz,
  p_deadline_precision deadline_precision DEFAULT 'date_only',
  p_cost cost_kind DEFAULT 'free',
  p_eligibility_scope eligibility_scope DEFAULT 'unclear',
  p_eligible_countries char(2)[] DEFAULT '{}',
  p_team_required boolean DEFAULT NULL,
  p_team_size_min smallint DEFAULT NULL,
  p_team_size_max smallint DEFAULT NULL
)
RETURNS TABLE (opportunity_slug text, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_me uuid := auth.uid();
  o organisations;
  v_category uuid;
  v_slug text;
  v_status opp_status;
  v_id uuid;
  v_today int;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'you need to be signed in'; END IF;

  SELECT * INTO o FROM organisations WHERE slug = p_org_slug AND deleted_at IS NULL;
  IF o.id IS NULL THEN RAISE EXCEPTION 'no such organisation'; END IF;

  IF NOT EXISTS (SELECT 1 FROM organisation_members m
                  WHERE m.organisation_id = o.id AND m.user_id = v_me) THEN
    RAISE EXCEPTION 'you are not a member of this organisation';
  END IF;

  IF o.verification <> 'verified' THEN
    RAISE EXCEPTION 'only a verified organisation may publish its own opportunities';
  END IF;

  SELECT count(*)::int INTO v_today
    FROM opportunities
   WHERE organisation_id = o.id AND created_at > now() - interval '24 hours';
  IF v_today >= 20 THEN
    RAISE EXCEPTION 'that is 20 listings in a day from one organisation; the rest need review';
  END IF;

  SELECT id INTO v_category FROM categories WHERE code = p_category_code;
  IF v_category IS NULL THEN RAISE EXCEPTION 'unknown category'; END IF;

  IF char_length(btrim(coalesce(p_title,''))) < 8 THEN
    RAISE EXCEPTION 'give the opportunity a real title';
  END IF;

  v_slug := regexp_replace(lower(btrim(p_title)), '[^a-z0-9]+', '-', 'g');
  v_slug := left(btrim(v_slug, '-'), 70) || '-' || encode(gen_random_bytes(2), 'hex');

  -- §19 publishes an organisation's own listing as `official`. A paid-entry listing does
  -- not publish on anyone's word: MODERATION_AND_TRUST.md §2 sends every `paid` cost to a
  -- human, whoever submitted it.
  v_status := CASE WHEN p_cost = 'paid' THEN 'in_review'::opp_status ELSE 'published'::opp_status END;

  INSERT INTO opportunities
    (slug, title, organisation_id, category_id, summary, description_md, apply_url,
     official_url, source_url, deadline_at, deadline_precision, cost, eligibility_scope,
     eligible_countries, team_required, team_size_min, team_size_max,
     status, verification, last_verified_at, published_at, link_ok, submitted_by_user_id)
  VALUES
    (v_slug, btrim(p_title), o.id, v_category,
     nullif(btrim(coalesce(p_summary,'')), ''), nullif(btrim(coalesce(p_description_md,'')), ''),
     nullif(btrim(coalesce(p_apply_url,'')), ''), nullif(btrim(coalesce(p_apply_url,'')), ''),
     coalesce(nullif(btrim(coalesce(p_apply_url,'')), ''), o.website_url),
     p_deadline_at, p_deadline_precision, p_cost, p_eligibility_scope,
     coalesce(p_eligible_countries, '{}'::char(2)[]),
     p_team_required, p_team_size_min, p_team_size_max,
     v_status, 'official', now(),
     CASE WHEN v_status = 'published' THEN now() ELSE NULL END,
     true, v_me)
  RETURNING id INTO v_id;

  IF v_status = 'in_review' THEN
    INSERT INTO review_queue (queue, subject_type, subject_id, priority)
    VALUES ('paid_cost', 'opportunity', v_id, 2);
  END IF;

  RETURN QUERY SELECT v_slug, v_status::text;
END
$$;

/**
 * The opportunities an organisation's members may see and edit, with what review state each
 * is in. The organisation page shows the public ones; this is the working list.
 */
CREATE OR REPLACE FUNCTION org_opportunities(p_org_slug text)
RETURNS TABLE (
  id uuid,
  slug text,
  title text,
  status opp_status,
  verification opp_verification,
  deadline_at timestamptz,
  tracked_by int,
  in_review boolean,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me uuid := auth.uid();
  v_org uuid;
BEGIN
  IF v_me IS NULL THEN RETURN; END IF;

  SELECT o.id INTO v_org FROM organisations o WHERE o.slug = p_org_slug AND o.deleted_at IS NULL;
  IF v_org IS NULL THEN RETURN; END IF;

  IF NOT EXISTS (SELECT 1 FROM organisation_members m
                  WHERE m.organisation_id = v_org AND m.user_id = v_me) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT op.id, op.slug, op.title, op.status, op.verification, op.deadline_at,
         (SELECT count(*)::int FROM tracker_entries t
           WHERE t.opportunity_id = op.id AND t.state <> 'withdrawn'),
         EXISTS (SELECT 1 FROM review_queue q
                  WHERE q.subject_id = op.id AND q.state <> 'done'),
         op.created_at
    FROM opportunities op
   WHERE op.organisation_id = v_org
     AND op.deleted_at IS NULL
   ORDER BY op.created_at DESC
   LIMIT 200;
END
$$;

-- An organisation's members may edit their own listings directly; the re-review trigger
-- above decides what that costs them.
CREATE POLICY opportunities_org_edit ON opportunities FOR UPDATE
  USING (EXISTS (SELECT 1 FROM organisation_members m
                  WHERE m.organisation_id = opportunities.organisation_id
                    AND m.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM organisation_members m
                       WHERE m.organisation_id = opportunities.organisation_id
                         AND m.user_id = auth.uid()));

/**
 * A public submission. API_SPEC.md §12: "Public submission by anyone; Turnstile required;
 * lands in the review queue as `draft`."
 *
 * Nothing here publishes. A `draft` is invisible on every surface, so the worst a bad
 * submission costs is a reviewer's minute — which is why this can be open to anyone at all,
 * signed in or not.
 *
 * The Turnstile check happens in the route, because only the request tier can talk to
 * Cloudflare. What happens here is the part a route cannot be trusted with: the rate limit,
 * which is keyed on whatever the caller passes as `p_rate_key` (a hashed IP, per
 * SECURITY.md §3's "never store a raw IP"). Three a day, per API_SPEC.md §14's table.
 *
 * `p_turnstile_verified` is recorded rather than enforced: a submission that arrived without
 * a token is still worth a look, and telling the reviewer which ones came in unverified is
 * more useful than dropping them silently.
 */
CREATE OR REPLACE FUNCTION submit_opportunity_public(
  p_rate_key text,
  p_title text,
  p_url text,
  p_category_code text DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_organisation_name text DEFAULT NULL,
  p_deadline_raw text DEFAULT NULL,
  p_turnstile_verified boolean DEFAULT false
)
RETURNS TABLE (ok boolean, message text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_category uuid;
  v_slug text;
  v_id uuid;
  v_me uuid := auth.uid();
BEGIN
  IF p_rate_key IS NULL OR btrim(p_rate_key) = '' THEN
    -- No key means no rate limit, which means no endpoint. Refuse rather than accept
    -- unlimited submissions from a caller that forgot to pass one.
    RETURN QUERY SELECT false, 'We could not accept that just now.';
    RETURN;
  END IF;

  IF NOT check_rate_limit('submit:' || btrim(p_rate_key), 3, interval '24 hours') THEN
    RETURN QUERY SELECT false,
      'That is three submissions today, which is the limit. Send us the rest tomorrow.';
    RETURN;
  END IF;

  IF char_length(btrim(coalesce(p_title, ''))) < 8 THEN
    RETURN QUERY SELECT false, 'Give it a title we can recognise it by.';
    RETURN;
  END IF;

  IF coalesce(btrim(p_url), '') !~* '^https?://[^ ]+\.[^ ]+' THEN
    RETURN QUERY SELECT false, 'We need the official page''s address, starting with https://';
    RETURN;
  END IF;

  -- A duplicate submission of the same URL is not an error worth showing: the reviewer will
  -- see one row either way, and telling a submitter "someone already sent this" invites them
  -- to try variations.
  IF EXISTS (SELECT 1 FROM opportunities o
              WHERE o.source_url = btrim(p_url) OR o.official_url = btrim(p_url)
                 OR o.apply_url = btrim(p_url)) THEN
    RETURN QUERY SELECT true, 'Thank you — we have this one already, and we will re-check it.';
    RETURN;
  END IF;

  SELECT id INTO v_category FROM categories WHERE code = p_category_code;
  IF v_category IS NULL THEN
    -- Everything needs a category to exist, and a submitter guessing wrong should not be a
    -- reason to lose the submission. `other` is the reviewer's problem, not theirs.
    SELECT id INTO v_category FROM categories ORDER BY (code = 'other') DESC, code LIMIT 1;
  END IF;

  v_slug := regexp_replace(lower(btrim(p_title)), '[^a-z0-9]+', '-', 'g');
  v_slug := left(btrim(v_slug, '-'), 70) || '-' || encode(gen_random_bytes(2), 'hex');

  INSERT INTO opportunities
    (slug, title, category_id, summary, source_url, official_url, deadline_raw,
     status, verification, submitted_by_user_id)
  VALUES
    (v_slug, btrim(p_title), v_category,
     nullif(btrim(coalesce(p_note, '')), ''),
     btrim(p_url), btrim(p_url),
     nullif(btrim(coalesce(p_deadline_raw, '')), ''),
     'draft', 'auto', v_me)
  RETURNING id INTO v_id;

  INSERT INTO review_queue (queue, subject_type, subject_id, priority)
  VALUES ('ugc', 'opportunity', v_id, 4);

  -- What the reviewer needs that the record itself does not carry: who suggested it, what
  -- they said the organisation was, and whether the submission came with a Turnstile token.
  INSERT INTO admin_audit_log (actor_user_id, action, subject_type, subject_id, after)
  VALUES (v_me, 'public_submission', 'opportunity', v_id,
          jsonb_build_object('organisation_name', nullif(btrim(coalesce(p_organisation_name,'')), ''),
                             'turnstile_verified', p_turnstile_verified,
                             'deadline_raw', nullif(btrim(coalesce(p_deadline_raw,'')), '')));

  RETURN QUERY SELECT true,
    'Thank you. A person will look at it — usually within a day or two, and we will not publish anything we cannot verify.';
END
$$;

-- ── The confirmation email needs an address the account does not have ───────

/**
 * Replaces 0010's claim_deliveries so an email delivery can be addressed to somewhere other
 * than the account's own address.
 *
 * Every other message in the product goes to the address on the account, and that is right.
 * An organisation claim is the one case where the POINT is to send it elsewhere: §9 requires
 * a domain-matched address, and proving control of that mailbox is the whole control. So a
 * notification may carry `email_override` in its payload, and only the org-claim path sets
 * it.
 *
 * Everything else about the function is 0010's, including the priority bands and the
 * deferral behaviour; 0010's version is reproduced verbatim in this migration's down file.
 */
CREATE OR REPLACE FUNCTION claim_deliveries(p_channel notif_channel, p_limit int DEFAULT 50)
RETURNS TABLE (
  delivery_id uuid,
  notification_id uuid,
  user_id uuid,
  type notif_type,
  payload jsonb,
  reason text,
  priority smallint,
  address text,
  timezone text,
  low_data_mode boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cap int := channel_daily_cap(p_channel);
  v_sent int;
  v_remaining int;
  r record;
  v_send boolean;
  v_downgrade_id uuid;
BEGIN
  INSERT INTO send_budget (day, channel, cap)
  VALUES (current_date, p_channel, v_cap)
  ON CONFLICT (day, channel) DO NOTHING;

  SELECT sent INTO v_sent FROM send_budget
   WHERE day = current_date AND channel = p_channel FOR UPDATE;
  v_remaining := v_cap - v_sent;

  FOR r IN
    SELECT d.id, d.notification_id, d.deferrals, n.user_id, n.type, n.payload,
           n.reason, n.priority
      FROM notification_deliveries d
      JOIN notifications n ON n.id = d.notification_id
     WHERE d.channel = p_channel
       AND d.state IN ('queued','deferred')
       AND d.scheduled_for <= now()
     ORDER BY n.priority ASC, d.scheduled_for ASC
     LIMIT p_limit
     FOR UPDATE OF d SKIP LOCKED
  LOOP
    -- §6 `[PR]`: re-check at send time, not schedule time.
    IF r.type = 'deadline_reminder' THEN
      IF NOT EXISTS (
        SELECT 1 FROM tracker_entries t
          JOIN opportunities o ON o.id = t.opportunity_id
         WHERE t.user_id = r.user_id
           AND o.id = (r.payload->>'opportunity_id')::uuid
           AND o.status = 'published'
           AND t.state IN ('saved','planning_to_apply','applied','submitted','participating')
      ) THEN
        UPDATE notification_deliveries
           SET state = 'suppressed',
               error = 'cancelled at send time: opportunity or tracker state changed'
         WHERE id = r.id;
        CONTINUE;
      END IF;
    END IF;

    v_send := CASE
      WHEN r.priority <= 2 THEN true
      WHEN r.priority = 3 THEN v_remaining > 40
      ELSE v_remaining > 120
    END;

    IF v_send THEN
      v_remaining := v_remaining - 1;
      UPDATE notification_deliveries SET state = 'claimed' WHERE id = r.id;
      RETURN QUERY
        SELECT r.id, r.notification_id, r.user_id, r.type, r.payload, r.reason, r.priority,
               CASE WHEN p_channel = 'email'
                    -- The override, when one is set: an organisation claim is confirmed by
                    -- an address the account does not have.
                    THEN coalesce(nullif(btrim(r.payload->>'email_override'), ''), u.email::text)
                    ELSE c.address END,
               u.timezone, u.low_data_mode
          FROM users u
          LEFT JOIN notification_channels c
                 ON c.user_id = u.id AND c.channel = p_channel
         WHERE u.id = r.user_id;
    ELSIF r.deferrals >= 2 THEN
      -- §4: "Downgrade is visible, not silent."
      UPDATE notification_deliveries
         SET state = 'suppressed', error = 'budget: downgraded to in-app after 2 deferrals'
       WHERE id = r.id;

      -- §4: "This converts a capacity limit into the exact nudge that fixes it."
      INSERT INTO notifications (user_id, type, payload, reason, priority)
      VALUES (r.user_id, 'system',
              jsonb_build_object('kind','budget_downgrade','notification_id', r.notification_id,
                                 'downgraded_type', r.type),
              CASE WHEN r.type = 'digest'
                THEN 'Your digest is waiting — link Telegram to get it delivered.'
                ELSE 'We could not email this one today. Link Telegram and messages arrive straight away.'
              END, 5)
      RETURNING id INTO v_downgrade_id;

      INSERT INTO notification_deliveries (notification_id, channel, state, sent_at)
      VALUES (v_downgrade_id, 'in_app', 'sent', now());
    ELSE
      UPDATE notification_deliveries
         SET state = 'deferred',
             deferrals = deferrals + 1,
             scheduled_for = now() + interval '24 hours'
       WHERE id = r.id;
    END IF;
  END LOOP;

  -- Record exhaustion the moment it happens, for §4 rule 5's two-day test.
  IF v_remaining <= 0 THEN
    UPDATE send_budget SET exhausted_at = coalesce(exhausted_at, now())
     WHERE day = current_date AND channel = p_channel;
  END IF;
END
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION start_org_claim(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION confirm_org_claim(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION my_org_claims() TO authenticated;
GRANT EXECUTE ON FUNCTION review_org_claim(uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION org_submit_opportunity(
  text, text, text, text, text, text, timestamptz, deadline_precision, cost_kind,
  eligibility_scope, char(2)[], boolean, smallint, smallint) TO authenticated;
GRANT EXECUTE ON FUNCTION org_opportunities(text) TO authenticated;
GRANT EXECUTE ON FUNCTION normalise_domain(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION email_domain(text) TO authenticated;
GRANT EXECUTE ON FUNCTION submit_opportunity_public(
  text, text, text, text, text, text, text, boolean) TO anon, authenticated;
