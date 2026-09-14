/**
 * Organisations, self-serve. PRODUCT_SPEC.md §19, MODERATION_AND_TRUST.md §9.
 *
 * Everything here goes through a function in migration 0021 rather than a table write, for
 * one reason: `official` verification and `verified` organisation state are claims about
 * provenance, and a route that could write them directly would be a route that could grant
 * them. The domain match, the token, the re-review rule and the publish path all live in the
 * database, and this module is the typed wrapper.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface ClaimStart {
  claim_id: string;
  domain_matches: boolean;
  status: "pending" | "awaiting_review";
  organisation_domain: string | null;
}

export interface MyClaim {
  claim_id: string;
  organisation_slug: string;
  organisation_name: string;
  claim_email: string;
  domain_matches: boolean;
  status: string;
  review_note: string | null;
  created_at: string;
  email_sent_at: string | null;
}

export interface OrgOpportunity {
  id: string;
  slug: string;
  title: string;
  status: string;
  verification: string;
  deadline_at: string | null;
  tracked_by: number;
  in_review: boolean;
  created_at: string;
}

const firstRow = <T>(data: unknown): T | null =>
  Array.isArray(data) ? ((data[0] as T) ?? null) : ((data as T) ?? null);

/** The message a route shows when the database refuses. Its wording is the honest one. */
export const dbMessage = (message: string): string =>
  message.replace(/^[a-z ]*error:?\s*/i, "").replace(/\s+$/, "");

export async function startClaim(
  client: SupabaseClient,
  slug: string,
  claimEmail: string,
  evidenceUrl: string | null,
): Promise<{ ok: true; data: ClaimStart } | { ok: false; message: string }> {
  const { data, error } = await client.rpc("start_org_claim", {
    p_slug: slug,
    p_claim_email: claimEmail,
    p_evidence_url: evidenceUrl,
  });
  if (error) return { ok: false, message: dbMessage(error.message) };
  const row = firstRow<ClaimStart>(data);
  if (!row) return { ok: false, message: "We could not start that claim just now." };
  return { ok: true, data: row };
}

/**
 * Confirm from the emailed token.
 *
 * Callable by an anonymous visitor on purpose: the person who controls the organisation's
 * mailbox may not be the person who started the claim, and making them sign in first would
 * break the one flow the token exists for.
 */
export async function confirmClaim(
  client: SupabaseClient,
  token: string,
): Promise<{ ok: boolean; slug: string | null; name: string | null }> {
  const { data, error } = await client.rpc("confirm_org_claim", { p_token: token });
  const row = firstRow<{ ok: boolean; organisation_slug: string | null; organisation_name: string | null }>(
    data,
  );
  if (error || !row) return { ok: false, slug: null, name: null };
  return { ok: row.ok === true, slug: row.organisation_slug, name: row.organisation_name };
}

export async function getMyClaims(client: SupabaseClient): Promise<MyClaim[]> {
  const { data, error } = await client.rpc("my_org_claims");
  if (error || !Array.isArray(data)) return [];
  return data as MyClaim[];
}

export async function getOrgOpportunities(
  client: SupabaseClient,
  slug: string,
): Promise<OrgOpportunity[]> {
  const { data, error } = await client.rpc("org_opportunities", { p_org_slug: slug });
  if (error || !Array.isArray(data)) return [];
  return data as OrgOpportunity[];
}

export interface OrgSubmission {
  title: string;
  categoryCode: string;
  summary: string | null;
  descriptionMd: string | null;
  applyUrl: string | null;
  deadlineAt: string | null;
  deadlinePrecision: string;
  cost: string;
  eligibilityScope: string;
  eligibleCountries: string[];
  teamRequired: boolean | null;
  teamSizeMin: number | null;
  teamSizeMax: number | null;
}

export async function submitAsOrganisation(
  client: SupabaseClient,
  slug: string,
  input: OrgSubmission,
): Promise<{ ok: true; slug: string; status: string } | { ok: false; message: string }> {
  const { data, error } = await client.rpc("org_submit_opportunity", {
    p_org_slug: slug,
    p_title: input.title,
    p_category_code: input.categoryCode,
    p_summary: input.summary,
    p_description_md: input.descriptionMd,
    p_apply_url: input.applyUrl,
    p_deadline_at: input.deadlineAt,
    p_deadline_precision: input.deadlinePrecision,
    p_cost: input.cost,
    p_eligibility_scope: input.eligibilityScope,
    p_eligible_countries: input.eligibleCountries,
    p_team_required: input.teamRequired,
    p_team_size_min: input.teamSizeMin,
    p_team_size_max: input.teamSizeMax,
  });
  if (error) return { ok: false, message: dbMessage(error.message) };
  const row = firstRow<{ opportunity_slug: string; status: string }>(data);
  if (!row) return { ok: false, message: "We could not save that just now." };
  return { ok: true, slug: row.opportunity_slug, status: row.status };
}

/**
 * Cloudflare Turnstile. SECURITY.md §4 and API_SPEC.md §12 require it on the public
 * submission form.
 *
 * Returns `null` when unconfigured, which the caller records rather than treats as a pass:
 * nothing a public submission produces is visible to anyone until a human reviews it, so an
 * unverified submission is a reviewer's judgement rather than a hole. A hard failure here
 * would mean the form simply does not work in any environment without a Turnstile key, and
 * the review queue is the real gate.
 */
export async function verifyTurnstile(
  token: string | null,
  secret: string | undefined,
  ip: string | null,
): Promise<boolean | null> {
  if (!secret) return null;
  if (!token) return false;
  try {
    const body = new FormData();
    body.append("secret", secret);
    body.append("response", token);
    if (ip) body.append("remoteip", ip);
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
    });
    const json = (await res.json()) as { success?: boolean };
    return json?.success === true;
  } catch {
    return false;
  }
}

/**
 * A stable, non-identifying key for the submission rate limit.
 *
 * SECURITY.md §3: never store a raw IP. This hashes the address with a per-environment salt
 * so the counter can be keyed on "the same submitter" without the address being recoverable
 * from the database.
 */
export async function rateKeyForIp(ip: string | null, salt: string | undefined): Promise<string> {
  const material = `${salt ?? "unsalted"}:${ip ?? "unknown"}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** UX_FLOWS.md §12's four states, in the words the page uses. */
export const ORG_STATE_LABEL: Record<string, string> = {
  unclaimed: "Not claimed",
  claimed_pending: "Claim in progress",
  verified: "Verified",
  rejected: "Not claimed",
  suspended: "Suspended",
};
