/**
 * The admin data layer. ADMIN_SYSTEM.md.
 *
 * Every call is a function from migration 0022, and each of those checks the caller's role
 * itself. That is the design: a page that forgot a guard would get an empty result or an
 * exception rather than somebody else's data, and the audit row is written by the same
 * statement as the change — so "did this action get audited?" is not a question about the
 * page.
 *
 * §12's constraints shape this module too. There is no client-side state, no island and no
 * polling: the admin routes carry the same 200 KB budget as the public ones, because "the
 * operator is often on the same expensive connection as the users".
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** MODERATION_AND_TRUST.md §3's seven queues, in the order §2's dashboard lists them. */
export const QUEUES = [
  { key: "report_scam", label: "Scam reports", urgent: true },
  { key: "report_safety", label: "Safety reports", urgent: true },
  { key: "paid_cost", label: "Entry fees", urgent: false },
  { key: "low_confidence", label: "Low confidence", urgent: false },
  { key: "duplicate", label: "Possible duplicates", urgent: false },
  { key: "org_claim", label: "Organisation claims", urgent: false },
  { key: "ugc", label: "Submitted and edited", urgent: false },
  { key: "extraction", label: "Extraction failures", urgent: false },
] as const;

export type QueueKey = (typeof QUEUES)[number]["key"];

export const queueLabel = (key: string): string =>
  QUEUES.find((q) => q.key === key)?.label ?? key;

export interface DashboardQueue {
  queue: string;
  open: number;
  claimed: number;
  sla_hours: number;
  oldest_hours: number;
  breached: boolean;
}

export interface Dashboard {
  generated_at: string;
  queues: DashboardQueue[];
  sources: { total: number; active: number; degraded: number; awaiting_tos: number } | null;
  ingestion: { last_success_at: string | null; minutes_ago: number | null; silent: boolean } | null;
  ai: { provider: string; calls: number; tokens: number; failures: number }[];
  email: { used: number; cap: number; exhausted_at: string | null } | null;
  database_mb: number;
  database_near_limit: boolean;
  catalogue: {
    published: number;
    in_review: number;
    draft: number;
    stale: number;
    disputed: number;
    expired: number;
  } | null;
  today: {
    published: number;
    expired: number;
    reports: number;
    reports_resolved: number;
    signups: number;
  };
  extraction_quality: { reviews: number; approved_unedited_pct: number | null } | null;
  unnotified_alerts: number;
}

export interface QueueItem {
  queue_id: string;
  subject_type: string;
  subject_id: string;
  priority: number;
  state: string;
  claimed_by_name: string | null;
  claimed_by_me: boolean;
  age_hours: number;
  breached: boolean;
  title: string;
  detail: string;
}

export interface ReviewCard {
  opportunity: {
    id: string;
    slug: string;
    title: string;
    status: string;
    verification: string;
    confidence: number | null;
    summary: string | null;
    deadline_at: string | null;
    deadline_precision: string;
    deadline_raw: string | null;
    cost: string;
    cost_description: string | null;
    eligibility_scope: string;
    eligible_countries: string[];
    team_required: boolean | null;
    team_size_min: number | null;
    team_size_max: number | null;
    source_url: string | null;
    official_url: string | null;
    apply_url: string | null;
    organisation: string | null;
    organisation_slug: string | null;
    category: string | null;
    source_name: string | null;
    source_trust: number | null;
    submitted_by: string | null;
    tracked_by: number;
  };
  rules: {
    id: string;
    rule_type: string;
    params: Record<string, unknown>;
    source_quote: string;
    confidence: number;
    high_stakes: boolean;
    reviewed_at: string | null;
  }[];
  reports: { reason: string; detail: string | null; created_at: string }[];
  duplicates: {
    other_id: string;
    other_title: string;
    other_slug: string;
    score: number;
    method: string;
    model_verdict: string | null;
  }[];
}

export interface ReportCard {
  subject_type: string;
  subject_id: string;
  subject_title: string;
  subject_slug: string | null;
  report_count: number;
  distinct_reporters: number;
  weighted_score: number;
  reasons: string[];
  first_report_at: string;
  age_hours: number;
  breached: boolean;
  is_safety: boolean;
  latest_detail: string | null;
}

export interface AdminUser {
  user_id: string;
  handle: string | null;
  display_name: string | null;
  email: string | null;
  account_state: string;
  is_admin: boolean;
  admin_role: string | null;
  created_at: string;
  last_seen_at: string | null;
  reporter_weight: number;
  projects: number;
  teams: number;
  requests_sent: number;
  reports_filed: number;
  reports_against: number;
  moderation_actions: number;
}

export interface AdminSource {
  source_id: string;
  name: string;
  kind: string;
  url: string;
  is_active: boolean;
  robots_allowed: boolean | null;
  robots_checked_at: string | null;
  tos_posture: string | null;
  cadence_minutes: number;
  trust_score: number;
  consecutive_failures: number;
  last_success_at: string | null;
  hours_since_success: number | null;
  records_published: number;
  reports_attributable: number;
  can_activate: boolean;
  blocker: string | null;
}

export interface AuditRow {
  id: number;
  ts: string;
  actor_name: string | null;
  action: string;
  subject_type: string | null;
  subject_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface DensityRow {
  flag: string;
  enabled: boolean;
  description: string | null;
  condition_met: boolean | null;
  detail: string | null;
}

const rows = <T>(data: unknown): T[] => (Array.isArray(data) ? (data as T[]) : []);

export async function getDashboard(client: SupabaseClient): Promise<Dashboard | null> {
  const { data, error } = await client.rpc("admin_dashboard");
  if (error || !data) return null;
  return data as Dashboard;
}

export async function getQueue(
  client: SupabaseClient,
  queue: string,
  limit = 25,
): Promise<QueueItem[]> {
  const { data, error } = await client.rpc("admin_queue", { p_queue: queue, p_limit: limit });
  if (error) return [];
  return rows<QueueItem>(data);
}

export async function getReviewCard(
  client: SupabaseClient,
  opportunityId: string,
): Promise<ReviewCard | null> {
  const { data, error } = await client.rpc("admin_review_card", {
    p_opportunity_id: opportunityId,
  });
  if (error || !data) return null;
  return data as ReviewCard;
}

export async function getReportInbox(
  client: SupabaseClient,
  safetyOnly: boolean | null = null,
): Promise<ReportCard[]> {
  const { data, error } = await client.rpc("admin_report_inbox", {
    p_safety_only: safetyOnly,
    p_limit: 25,
  });
  if (error) return [];
  return rows<ReportCard>(data);
}

export async function searchUsers(
  client: SupabaseClient,
  query: string,
): Promise<AdminUser[]> {
  const { data, error } = await client.rpc("admin_user_search", { p_query: query, p_limit: 20 });
  if (error) return [];
  return rows<AdminUser>(data);
}

export async function getSources(client: SupabaseClient): Promise<AdminSource[]> {
  const { data, error } = await client.rpc("admin_sources");
  if (error) return [];
  return rows<AdminSource>(data);
}

export async function getAudit(
  client: SupabaseClient,
  filters: { action?: string | null; subjectId?: string | null } = {},
): Promise<AuditRow[]> {
  const { data, error } = await client.rpc("admin_audit_search", {
    p_actor: null,
    p_subject_id: filters.subjectId ?? null,
    p_action: filters.action ?? null,
    p_since: null,
    p_limit: 50,
  });
  if (error) return [];
  return rows<AuditRow>(data);
}

export async function getDensityStatus(client: SupabaseClient): Promise<DensityRow[]> {
  const { data, error } = await client.rpc("admin_density_status");
  if (error) return [];
  return rows<DensityRow>(data);
}

/**
 * A hashed IP for the audit row. §11 requires one; SECURITY.md §3 forbids the raw address.
 *
 * Truncated to 32 hex characters, which is plenty to correlate two actions from one place
 * and not enough to be a lookup key for an address.
 */
export async function ipHash(
  ip: string | null,
  salt: string | undefined,
): Promise<string | null> {
  if (!ip) return null;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${salt ?? "unsalted"}:${ip}`),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/** The words an operator reads, not the enum values. */
export const ACTION_LABEL: Record<string, string> = {
  publish_unedited: "Published as extracted",
  publish_edited: "Published after an edit",
  reject: "Rejected",
  rule_add: "Rule added",
  rule_edit: "Rule edited",
  rule_delete: "Rule deleted",
  user_warn: "Warned",
  user_restrict: "Restricted",
  user_suspend: "Suspended",
  user_reinstate: "Reinstated",
  reports_upheld: "Reports upheld",
  reports_dismissed: "Reports dismissed",
  source_activate: "Source activated",
  source_deactivate: "Source paused",
  org_claim_approve: "Claim approved",
  org_claim_reject: "Claim rejected",
  public_submission: "Public submission",
};

export const RULE_TYPES = [
  "country_in",
  "country_not_in",
  "nationality_in",
  "residency_required",
  "age_between",
  "student_status_in",
  "year_of_study_in",
  "institution_type_in",
  "experience_between",
  "language_required",
  "gender_in",
  "team_size_between",
  "team_only",
  "individual_only",
  "sector_in",
  "employment_status_in",
  "other",
] as const;
