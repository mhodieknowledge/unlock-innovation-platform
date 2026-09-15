/**
 * Byte budgets for ON-DEMAND (SSR) routes. Invariant 5.
 *
 * scripts/byte-budget.mjs measures prerendered HTML in dist. Every interesting
 * route in this product renders on demand, including the opportunity detail page
 * — which has the tightest budget and is the route ADR 0001 was decided on — so
 * without this test invariant 5 is unenforced exactly where it matters most.
 *
 * Each route renders through Astro's container API with the data layer mocked,
 * against DELIBERATELY WORST-CASE data: long titles, maximum-length summaries,
 * ten eligibility rules each carrying a long verbatim quote, and a full page of
 * result rows. A thin fixture would flatter the budget and prove nothing.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { LOW_DATA_LIST_BUDGET, ROUTE_BUDGETS } from "@mbele/config";
import { RULE_TYPES } from "../src/lib/admin";
import svelteRenderer from "@astrojs/svelte/server.js";
import { beforeAll, describe, expect, it, vi } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(HERE, "..", "dist", "client");
const KB = 1024;

/**
 * PRODUCT_SPEC.md §25.1, for the routes that render on demand.
 *
 * The NUMBERS are not here. They come from packages/config/src/route-budgets.json, which is
 * the single source every reader shares — budgets.ts for the app, scripts/byte-budget.mjs for
 * the prerendered pages, and this table by route pattern. An earlier version of this file
 * carried its own copy of the KB figures, which is the same drift that once made the
 * prerendered gate fall back to the absolute ceiling and report a pass. A pattern with no
 * entry in the JSON throws rather than defaulting to anything.
 *
 * The labels ARE here, and are deliberately more specific than the JSON's: several routes
 * share one budget line ("Authenticated dashboard") and a failure message naming the page is
 * worth more than one naming the budget row.
 */
function budgetFor(label: string, pattern: string): { label: string; total: number; js: number } {
  const found = ROUTE_BUDGETS.find((b) => b.pattern === pattern);
  if (!found) {
    throw new Error(
      `No budget for "${pattern}" in packages/config/src/route-budgets.json. Add the route there, not here.`,
    );
  }
  return { label, total: found.totalBytes, js: found.jsBytes };
}

const BUDGETS = {
  // Phase 9. The board, measured with the eight rows §2 specifies and the whole country and
  // category link list under it.
  homepage: budgetFor("Homepage", "/"),
  detail: budgetFor("Opportunity detail", "/opportunities/*"),
  list: budgetFor("Opportunity list / search", "/opportunities"),
  organisation: budgetFor("Organisation page", "/organisations/*"),
  tracker: budgetFor("Authenticated dashboard", "/tracker"),
  notifications: budgetFor("Notification settings", "/you/*"),
  account: budgetFor("Account settings", "/you/*"),
  // Not an authenticated route: someone reaches it from an email, often on the
  // worst connection they have. §25.1's "any route" ceiling is 250 KB, but a page
  // with two buttons on it has no business anywhere near that, so it is held to
  // the tightest budget in the table.
  unsubscribe: budgetFor("Unsubscribe", "/unsubscribe"),
  dashboard: budgetFor("Your window", "/you/*"),
  // Phase 5's surfaces, each measured at the cap its own SQL enforces: 40 teams and 60
  // builders in a room, 100 requests, 50 threads, 200 messages. A room measured with three
  // teams in it would prove nothing about the room a successful launch produces.
  room: budgetFor("Team room", "/opportunities/*/room"),
  intent: budgetFor("Intent form", "/opportunities/*/intent"),
  teamNew: budgetFor("Team form", "/opportunities/*/teams/new"),
  requests: budgetFor("Requests", "/requests"),
  compose: budgetFor("Request composer", "/requests/new"),
  threads: budgetFor("Conversations", "/threads"),
  thread: budgetFor("One conversation", "/threads/*"),
  // Phase 6. The detail page is measured with ten matches and the edit page with the whole
  // tag vocabulary and every country in the select, which is the largest form in the
  // product.
  projectBrowse: budgetFor("Project browse", "/projects"),
  projectNew: budgetFor("New project", "/projects/new"),
  projectDetail: budgetFor("Project detail", "/projects/*"),
  projectEdit: budgetFor("Project edit", "/projects/*/edit"),
  myProjects: budgetFor("Your projects", "/you/*"),
  // Phase 7. The manage page is measured with 200 listings, which is the cap
  // org_opportunities enforces, and the whole category vocabulary in its form.
  orgClaim: budgetFor("Organisation claim", "/organisations/*/claim"),
  orgManage: budgetFor("Organisation manage", "/organisations/*/manage"),
  submitPublic: budgetFor("Public submission", "/submit"),
  // Phase 8. ADMIN_SYSTEM.md §12: "Byte budget applies: <= 200 KB per admin route. The
  // operator is often on the same expensive connection as the users." Measured with a full
  // queue and a review card carrying ten rules and their quotes.
  adminDashboard: budgetFor("Admin dashboard", "/admin"),
  adminQueue: budgetFor("Admin queue", "/admin/*/*"),
  adminReports: budgetFor("Admin reports", "/admin/*"),
  adminUsers: budgetFor("Admin people", "/admin/*"),
  adminSources: budgetFor("Admin sources", "/admin/*"),
  adminAudit: budgetFor("Admin audit", "/admin/*"),
} as const;

const LONG_QUOTE =
  "Applications are open to individuals who are resident in any African country at the time of submission, who are currently enrolled in or have recently completed a programme of study at a recognised institution, and who have not previously received funding under this scheme.";

const SUBJECTS = [
  "AgriTech", "Climate Resilience", "Health Data", "Fintech Inclusion",
  "Renewable Energy", "Open Transport", "Water Sanitation", "Civic Technology",
  "Creative Industries", "Youth Employment",
];
const KINDS = ["Innovation Challenge", "Fellowship", "Grant", "Accelerator", "Research Call"];
const PLACES = ["Southern Africa", "East Africa", "West Africa", "Pan-African", "Continental"];

/**
 * Distinct per row. Thirty near-identical titles gzip down to almost nothing,
 * which would flatter the budget with a compression artefact rather than measure
 * a realistic page.
 */
function worstCaseOpportunity(i: number) {
  const subject = SUBJECTS[i % SUBJECTS.length]!;
  const kind = KINDS[i % KINDS.length]!;
  const place = PLACES[i % PLACES.length]!;
  // Deadlines spread across the window so some rows land in "closing soon".
  const day = 15 + (i % 14);
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    slug: `worst-case-${i}`,
    title: `${place} ${subject} ${kind} for Early-Career Builders 2026, cohort ${i} (${subject} track)`,
    summary: "x".repeat(400),
    description_md: "y".repeat(4000),
    deadline_at: `2026-09-${String(day).padStart(2, "0")}T21:59:00Z`,
    deadline_precision: "date_only",
    deadline_raw: `Applications close ${day} September`,
    deadline_timezone: "Africa/Harare",
    opens_at: "2026-08-01T00:00:00Z",
    starts_at: "2027-01-15T00:00:00Z",
    ends_at: "2027-01-17T00:00:00Z",
    is_rolling: false,
    participation_mode: "online",
    eligibility_scope: "africa_wide",
    eligible_countries: ["ZW", "ZM", "BW", "NA", "MW", "MZ", "KE", "NG", "GH", "ZA"],
    team_required: true,
    team_size_min: 2,
    team_size_max: 5,
    prize_amount: 10000,
    prize_currency: "USD",
    cost: "free",
    cost_description: null,
    verification: "verified",
    last_verified_at: "2026-09-13T06:00:00Z",
    source_url: "https://example.org/source",
    official_url: "https://example.org/official",
    apply_url: "https://example.org/apply",
    status: "published",
    duplicate_of: null,
    organisations: {
      slug: "example-org",
      name: "Example Foundation for African Innovation",
      verification: "verified",
    },
    categories: { code: "ai_challenge", name: "AI challenge", slug: "ai-challenges" },
  };
}

const DETAIL = {
  opportunity: worstCaseOpportunity(1),
  rules: RULE_TYPES.map((rule_type, i) => ({
    id: `rule-${i}`,
    rule_type,
    params: { countries: ["ZW", "ZM"], min: 18, max: 30 },
    source_quote: LONG_QUOTE,
    confidence: 0.9,
  })),
};

// A full page of rows, which is what the list budget has to survive.
const PAGE_OF_ROWS = Array.from({ length: 20 }, (_, i) => worstCaseOpportunity(i + 1));

// A busy tracker: 30 entries is well past what a real user accumulates, so the
// dashboard budget is measured against a worse case than it will meet.
const TRACKER_ROWS = Array.from({ length: 30 }, (_, i) => ({
  id: `entry-${i}`,
  state: ["saved", "planning_to_apply", "applied", "submitted", "participating"][i % 5]!,
  note: "n".repeat(200),
  applied_at: null,
  remind_at: null,
  updated_at: "2026-09-13T00:00:00Z",
  opportunities: worstCaseOpportunity(i + 1),
}));

const ORGANISATION = {
  organisation: {
    id: "org-1",
    slug: "example-org",
    name: "Example Foundation for African Innovation",
    description: "z".repeat(2000),
    website_url: "https://example.org",
    country_iso2: "GH",
    org_type: "foundation",
    verification: "verified",
    verified_at: "2026-05-01T00:00:00Z",
  },
  open: PAGE_OF_ROWS.slice(0, 10),
  past: PAGE_OF_ROWS.slice(10),
};

const SESSION_USER = {
  id: "aaaa1111-1111-1111-1111-111111111111",
  email: "t@example.invalid",
  handle: null,
  display_name: "Test",
  is_admin: true,
  admin_role: "superadmin",
  account_state: "active",
  age_confirmed_18: true,
  timezone: "Africa/Harare",
  low_data_mode: false,
  // Admin routes render only for an admin, and §12's budget applies to them — so the
  // fixture session is a superadmin, which is also the role that sees the MOST markup
  // (every nav item, the audit page, the flag switches).
};

/**
 * Phase 5 fixtures, at the caps migration 0017's functions enforce.
 *
 * Distinct text per row for the same reason the opportunity fixtures are distinct: sixty
 * near-identical builder cards gzip to almost nothing and would flatter the budget with a
 * compression artefact rather than measure a real room.
 */
const LONG_PITCH =
  "We are building a soil-moisture logger from a microcontroller, two probes and a solar panel, and we need someone who can get the readings onto a phone over Bluetooth without a data plan. ";

const ROOM_TEAMS = Array.from({ length: 40 }, (_, i) => ({
  team_id: `team-${i}`,
  name: `${SUBJECTS[i % SUBJECTS.length]} ${KINDS[i % KINDS.length]} crew ${i + 1}`,
  pitch: (LONG_PITCH + SUBJECTS[i % SUBJECTS.length]).slice(0, 600),
  roles_needed: ["frontend", "hardware", "someone who can present", "data"].slice(0, (i % 4) + 1),
  member_count: (i % 3) + 1,
  max_size: 4,
  countries: ["ZW", "NG", "KE", "GH"].slice(0, (i % 4) + 1),
  state: i % 5 === 0 ? "full" : "open_for_roles",
  owner_user_id: `owner-${i}`,
  owner_display_name: `Team owner number ${i + 1}`,
  owner_stale: i % 7 === 0,
  i_am_member: false,
  i_own_it: false,
  my_request_state: i % 6 === 0 ? "pending" : null,
}));

const ROOM_BUILDERS = Array.from({ length: 60 }, (_, i) => ({
  user_id: `builder-${i}`,
  display_name: `Builder with quite a long display name ${i + 1}`,
  country_iso2: ["ZW", "NG", "KE", "GH", "ZA", "TZ"][i % 6]!,
  headline: `Works on ${SUBJECTS[i % SUBJECTS.length]} and ${PLACES[i % PLACES.length]} logistics`,
  roles_offered: ["backend", "data", "design", "pitching"].slice(0, (i % 4) + 1),
  note: (LONG_PITCH + ` Note ${i}`).slice(0, 300),
  stance: i % 2 === 0 ? "looking_for_team" : "have_team_looking_for_roles",
  leads_a_team: i % 4 === 0,
  request_state: i % 5 === 0 ? "pending" : null,
}));

const MY_ROOM_STATUS = [
  {
    stance: "have_team_looking_for_roles",
    roles_offered: ["backend", "hardware"],
    note: "Building an irrigation monitor with two other people from Harare.",
    intent_expires_at: "2026-11-01T00:00:00Z",
    my_team_id: "team-0",
    my_team_name: "AgriTech Innovation Challenge crew 1",
    i_own_my_team: true,
    requests_in: 3,
    requests_out: 2,
  },
];

const ALLOWANCE = [
  {
    day_used: 4,
    day_limit: 10,
    hour_used: 1,
    hour_limit: 3,
    pending_used: 2,
    pending_limit: 5,
    next_slot_at: null,
    blocked_reason: null,
  },
];

const REQUEST_ROWS = Array.from({ length: 100 }, (_, i) => ({
  request_id: `request-${i}`,
  context: i % 2 === 0 ? "team_request" : "opportunity_intent",
  state: i < 40 ? "pending" : i % 2 === 0 ? "accepted" : "declined",
  role: ["frontend", "data", "hardware", null][i % 4],
  message: (LONG_PITCH + ` I would like to help with ${SUBJECTS[i % SUBJECTS.length]}.`).slice(0, 500),
  created_at: "2026-09-10T09:00:00Z",
  expires_at: "2026-09-24T09:00:00Z",
  counterpart_user_id: `person-${i}`,
  counterpart_display_name: `Somebody with a long name number ${i + 1}`,
  counterpart_country: ["ZW", "NG", "KE"][i % 3]!,
  counterpart_headline: `Builds ${SUBJECTS[i % SUBJECTS.length]} things in ${PLACES[i % PLACES.length]}`,
  counterpart_roles: ["backend", "design"],
  opportunity_slug: `worst-case-${(i % 20) + 1}`,
  opportunity_title: worstCaseOpportunity((i % 20) + 1).title,
  team_id: i % 2 === 0 ? `team-${i % 40}` : null,
  team_name: i % 2 === 0 ? ROOM_TEAMS[i % 40]!.name : null,
}));

const THREAD_ROWS = Array.from({ length: 50 }, (_, i) => ({
  thread_id: `thread-${i}`,
  state: i % 10 === 0 ? "closed" : "open",
  closed_reason: i % 10 === 0 ? "left" : null,
  last_message_at: "2026-09-13T10:00:00Z",
  created_at: "2026-09-01T10:00:00Z",
  counterpart_display_name: `Conversation partner number ${i + 1}`,
  context_label: ROOM_TEAMS[i % 40]!.name,
  opportunity_slug: `worst-case-${(i % 20) + 1}`,
  unread_from_them: i % 3 === 0,
}));

const THREAD_HEADER = [
  {
    thread_id: "thread-0",
    state: "open",
    closed_reason: null,
    counterpart_user_id: "person-0",
    counterpart_display_name: "Conversation partner number 1",
    context_label: ROOM_TEAMS[0]!.name,
    opportunity_slug: "worst-case-1",
    handoff_state: "proposed",
    handoff_channel: "telegram",
    handoff_proposal_id: "proposal-0",
    handoff_is_mine: false,
  },
];

// §3.2 caps a message at 2,000 characters; the page reads at most 200 of them.
const THREAD_MESSAGES = Array.from({ length: 200 }, (_, i) => ({
  id: `message-${i}`,
  sender_user_id: i % 2 === 0 ? "aaaa1111-1111-1111-1111-111111111111" : "person-0",
  body: (LONG_PITCH.repeat(12) + ` Message ${i}.`).slice(0, 2000),
  created_at: "2026-09-13T10:00:00Z",
}));

/**
 * Phase 6 fixtures. COLLABORATION_SYSTEM.md §1's field lengths at their maximums: a 200-char
 * pitch, 2,000-char problem and solution, ten matches with four reasons each.
 */
const PROJECT_ROW = {
  id: "project-1",
  slug: "irrigation-monitor-7f3a91",
  owner_user_id: SESSION_USER.id,
  title: "Irrigation monitoring for smallholder farms across Southern Africa",
  pitch: "p".repeat(200),
  problem: (LONG_PITCH.repeat(12) + " problem").slice(0, 2000),
  solution: (LONG_PITCH.repeat(12) + " solution").slice(0, 2000),
  target_users: "t".repeat(500),
  state: "building",
  visibility: "public",
  indexable: true,
  category_ids: [],
  industry_ids: ["11111111-1111-1111-1111-111111111111"],
  skill_ids: [],
  technology_ids: [],
  roles_needed: ["22222222-2222-2222-2222-222222222222"],
  repo_url: "https://example.invalid/repo",
  demo_url: "https://example.invalid/demo",
  docs_url: "https://example.invalid/docs",
  country_iso2: "ZW",
  state_changed_at: "2026-08-01T00:00:00Z",
  last_activity_at: "2026-09-13T00:00:00Z",
  matched_at: "2026-09-13T00:00:00Z",
  created_at: "2026-06-01T00:00:00Z",
  deleted_at: null,
};

const PROJECT_MATCHES = Array.from({ length: 10 }, (_, i) => ({
  opportunity_id: `opp-${i}`,
  slug: `worst-case-${i + 1}`,
  title: worstCaseOpportunity(i + 1).title,
  organisation_name: "Example Foundation for African Innovation",
  deadline_at: worstCaseOpportunity(i + 1).deadline_at,
  deadline_precision: "date_only",
  is_rolling: false,
  cost: "free",
  verdict: i % 3 === 0 ? "likely_eligible" : "eligible",
  score: 0.9 - i / 50,
  rank: i + 1,
  reasons: [
    SUBJECTS[i % SUBJECTS.length]!,
    "you're eligible",
    `closes in ${i + 3} days`,
    "team entry",
  ],
  tracked: i % 4 === 0,
}));

const PUBLIC_PROJECTS = Array.from({ length: 40 }, (_, i) => ({
  slug: `public-project-${i}`,
  title: `${SUBJECTS[i % SUBJECTS.length]} project number ${i + 1}`,
  pitch: (LONG_PITCH + ` number ${i}`).slice(0, 200),
  state: ["idea", "building", "testing", "looking_for_collaborators"][i % 4]!,
  country_iso2: ["ZW", "NG", "KE", "GH"][i % 4]!,
  last_activity_at: "2026-09-13T00:00:00Z",
}));

const RELATED_PROJECTS = Array.from({ length: 6 }, (_, i) => ({
  slug: `related-project-${i}`,
  title: `${SUBJECTS[i % SUBJECTS.length]} build ${i + 1}`,
  pitch: (LONG_PITCH + ` related ${i}`).slice(0, 200),
  state: "building",
  roles_needed: ["frontend", "data", "hardware"],
  country_iso2: "ZW",
}));

const TAG_VOCABULARY = ["skill", "technology", "industry", "role"].flatMap((kind) =>
  Array.from({ length: 10 }, (_, i) => ({
    id: `${kind}-${i}-2222-2222-2222-222222222222`,
    name: `${kind} option number ${i + 1}`,
    kind,
  })),
);

const COUNTRY_LIST = Array.from({ length: 54 }, (_, i) => ({
  iso2: String.fromCharCode(65 + (i % 26), 65 + Math.floor(i / 26)),
  name: `Country number ${i + 1} with a long name`,
}));

/** Phase 7 fixtures: an organisation at the cap org_opportunities allows. */
const ORG_LISTINGS = Array.from({ length: 200 }, (_, i) => ({
  id: `listing-${i}`,
  slug: `worst-case-${(i % 20) + 1}`,
  title: worstCaseOpportunity((i % 20) + 1).title,
  status: ["published", "in_review", "expired", "draft"][i % 4]!,
  verification: ["official", "auto", "verified", "stale"][i % 4]!,
  deadline_at: worstCaseOpportunity((i % 20) + 1).deadline_at,
  tracked_by: i % 7,
  in_review: i % 4 === 1,
  created_at: "2026-08-01T00:00:00Z",
}));

const MY_CLAIMS = Array.from({ length: 5 }, (_, i) => ({
  claim_id: `claim-${i}`,
  organisation_slug: "example-org",
  organisation_name: "Example Foundation for African Innovation",
  claim_email: `programme.officer.${i}@example.org`,
  domain_matches: i % 2 === 0,
  status: ["pending", "awaiting_review", "approved", "rejected", "expired"][i]!,
  review_note: i === 3 ? "The staff page did not mention this person." : null,
  created_at: "2026-09-10T00:00:00Z",
  email_sent_at: i === 0 ? "2026-09-10T00:05:00Z" : null,
}));

const CATEGORY_VOCABULARY = Array.from({ length: 14 }, (_, i) => ({
  code: `category-${i}`,
  name: `${SUBJECTS[i % SUBJECTS.length]} ${KINDS[i % KINDS.length]}`,
}));

/**
 * Phase 8 fixtures. A queue at its cap, a review card with ten rules each carrying a long
 * verbatim quote, twenty-five grouped report cards and fifty audit rows with before/after
 * JSON — which is the largest thing any admin page renders.
 */
const ADMIN_DASHBOARD = {
  generated_at: "2026-09-15T08:00:00Z",
  queues: [
    { queue: "report_scam", open: 3, claimed: 1, sla_hours: 12, oldest_hours: 19.4, breached: true },
    { queue: "low_confidence", open: 41, claimed: 2, sla_hours: 72, oldest_hours: 60.2, breached: false },
    { queue: "duplicate", open: 12, claimed: 0, sla_hours: 48, oldest_hours: 30.1, breached: false },
    { queue: "org_claim", open: 2, claimed: 0, sla_hours: 48, oldest_hours: 5.5, breached: false },
    { queue: "ugc", open: 8, claimed: 0, sla_hours: 48, oldest_hours: 12.0, breached: false },
  ],
  sources: { total: 38, active: 36, degraded: 2, awaiting_tos: 2 },
  ingestion: { last_success_at: "2026-09-15T07:19:00Z", minutes_ago: 41, silent: false },
  ai: [
    { provider: "groq", calls: 220, tokens: 184_000, failures: 3 },
    { provider: "gemini", calls: 88, tokens: 96_000, failures: 0 },
  ],
  email: { used: 118, cap: 280, exhausted_at: null },
  database_mb: 312.4,
  database_near_limit: false,
  catalogue: { published: 3412, in_review: 41, draft: 60, stale: 47, disputed: 2, expired: 8 },
  today: { published: 14, expired: 4, reports: 9, reports_resolved: 6, signups: 23 },
  extraction_quality: { reviews: 50, approved_unedited_pct: 58 },
  unnotified_alerts: 1,
};

const ADMIN_QUEUE_ITEMS = Array.from({ length: 25 }, (_, i) => ({
  queue_id: `queue-${i}`,
  subject_type: "opportunity",
  subject_id: `opp-${i}`,
  priority: (i % 5) + 1,
  state: i % 6 === 0 ? "claimed" : "open",
  claimed_by_name: i % 6 === 0 ? "Another Reviewer" : null,
  claimed_by_me: false,
  age_hours: 80 - i,
  breached: i < 4,
  title: worstCaseOpportunity(i + 1).title,
  detail: `Example Foundation for African Innovation · auto · confidence 0.${60 + (i % 40)}`,
}));

const ADMIN_REVIEW_CARD = {
  opportunity: {
    id: "opp-0",
    slug: "worst-case-1",
    title: worstCaseOpportunity(1).title,
    status: "in_review",
    verification: "auto",
    confidence: 0.71,
    summary: "s".repeat(400),
    deadline_at: "2026-10-30T23:59:59Z",
    deadline_precision: "date_only",
    deadline_raw: "Applications close 30 September",
    cost: "free",
    cost_description: null,
    eligibility_scope: "country_list",
    eligible_countries: ["ZW", "ZM", "KE", "NG", "GH", "TZ", "UG", "RW"],
    team_required: true,
    team_size_min: 2,
    team_size_max: 5,
    source_url: "https://example.invalid/source",
    official_url: "https://example.invalid/official",
    apply_url: "https://example.invalid/apply",
    organisation: "Example Foundation for African Innovation",
    organisation_slug: "example-org",
    category: "Grant",
    source_name: "A long source name for a regional aggregator",
    source_trust: 0.62,
    submitted_by: null,
    tracked_by: 17,
  },
  rules: RULE_TYPES.map((type, i) => ({
    id: `rule-${i}`,
    rule_type: type,
    params: { example: ["a", "b", "c"] },
    source_quote: LONG_QUOTE,
    confidence: 0.5 + i / 25,
    high_stakes: i < 5,
    reviewed_at: null,
  })),
  reports: Array.from({ length: 5 }, (_, i) => ({
    reason: ["possible_scam", "requires_payment", "wrong_deadline", "broken_link", "spam"][i]!,
    detail: LONG_QUOTE,
    created_at: "2026-09-14T00:00:00Z",
  })),
  duplicates: Array.from({ length: 3 }, (_, i) => ({
    other_id: `dup-${i}`,
    other_title: worstCaseOpportunity(i + 5).title,
    other_slug: `worst-case-${i + 5}`,
    score: 0.9 - i / 20,
    method: "trigram",
    model_verdict: i === 0 ? "same" : null,
  })),
};

const ADMIN_REPORTS = Array.from({ length: 25 }, (_, i) => ({
  subject_type: "opportunity",
  subject_id: `opp-${i}`,
  subject_title: worstCaseOpportunity(i + 1).title,
  subject_slug: `worst-case-${i + 1}`,
  report_count: (i % 5) + 1,
  distinct_reporters: (i % 4) + 1,
  weighted_score: 1 + i / 10,
  reasons: ["possible_scam", "requires_payment"],
  first_report_at: "2026-09-13T00:00:00Z",
  age_hours: 30 + i,
  breached: i < 3,
  is_safety: i % 2 === 0,
  latest_detail: LONG_QUOTE,
}));

const ADMIN_USERS = Array.from({ length: 20 }, (_, i) => ({
  user_id: `user-${i}`,
  handle: `builder${i}`,
  display_name: `A person with quite a long display name ${i + 1}`,
  email: `person${i}@example.invalid`,
  account_state: ["active", "restricted", "suspended"][i % 3]!,
  is_admin: false,
  admin_role: null,
  created_at: "2026-05-01T00:00:00Z",
  last_seen_at: "2026-09-14T00:00:00Z",
  reporter_weight: 1.0,
  projects: i % 4,
  teams: i % 3,
  requests_sent: i,
  reports_filed: i % 5,
  reports_against: i % 7,
  moderation_actions: i % 2,
}));

const ADMIN_SOURCES = Array.from({ length: 38 }, (_, i) => ({
  source_id: `source-${i}`,
  name: `A regional aggregator number ${i + 1}`,
  kind: "html_page",
  url: `https://example.invalid/source-${i}/opportunities/listing`,
  is_active: i % 4 !== 0,
  robots_allowed: i % 5 === 0 ? false : true,
  robots_checked_at: "2026-09-01T00:00:00Z",
  tos_posture: i % 6 === 0 ? null : "permits_feeds",
  cadence_minutes: 720,
  trust_score: 0.5,
  consecutive_failures: i % 7,
  last_success_at: "2026-09-15T00:00:00Z",
  hours_since_success: 8,
  records_published: i * 3,
  reports_attributable: i % 3,
  can_activate: i % 6 !== 0,
  blocker: i % 6 === 0 ? "nobody has recorded the terms-of-service posture" : null,
}));

const ADMIN_AUDIT = Array.from({ length: 50 }, (_, i) => ({
  id: 1000 - i,
  ts: "2026-09-15T07:00:00Z",
  actor_name: "A Reviewer",
  action: ["publish_unedited", "publish_edited", "reject", "rule_edit", "user_restrict"][i % 5]!,
  subject_type: "opportunity",
  subject_id: `aaaaaaaa-0000-0000-0000-00000000000${i % 10}`,
  before: { status: "in_review", source_quote: LONG_QUOTE },
  after: { status: "published", source_quote: LONG_QUOTE },
}));

/** Every RPC the Phase 5 pages call, with a filled-to-the-cap answer for each. */
const ROOM_RPC: Record<string, unknown> = {
  room_state: [{ state: "open", intent_count: 14, team_count: 6, reason: "room is open" }],
  intent_count_public: 14,
  room_teams: ROOM_TEAMS,
  room_builders: ROOM_BUILDERS,
  my_room_status: MY_ROOM_STATUS,
  request_allowance: ALLOWANCE,
  my_requests: REQUEST_ROWS,
  my_threads: THREAD_ROWS,
  thread_view: THREAD_HEADER,
  handoff_identifiers: [],
  project_matches: PROJECT_MATCHES,
  project_browse_state: [{ state: "open", public_projects: 47, floor: 40 }],
  projects_for_opportunity: RELATED_PROJECTS,
  project_interest_target: [],
  org_opportunities: ORG_LISTINGS,
  my_org_claims: MY_CLAIMS,
  submit_opportunity_public: [{ ok: true, message: "Thank you." }],
  confirm_org_claim: [{ ok: true, organisation_slug: "example-org", organisation_name: "Example Foundation for African Innovation" }],
  admin_dashboard: ADMIN_DASHBOARD,
  admin_queue: ADMIN_QUEUE_ITEMS,
  admin_review_card: ADMIN_REVIEW_CARD,
  admin_report_inbox: ADMIN_REPORTS,
  admin_user_search: ADMIN_USERS,
  admin_sources: ADMIN_SOURCES,
  admin_audit_search: ADMIN_AUDIT,
  admin_density_status: [
    { flag: "team_room_entry", enabled: false, description: "Team room entry point", condition_met: false, detail: "0 opportunities are above the room floor" },
    { flag: "public_project_browse", enabled: false, description: "Public project browse", condition_met: false, detail: "12 of 40 public projects" },
  ],
};

/**
 * Per-table fixtures for the authenticated pages, at their WORST plausible size:
 * every notification preference row written, Telegram linked, quiet hours set. A
 * settings page measured against an empty account would flatter its budget.
 */
const TABLE_ROWS: Record<string, unknown[]> = {
  tracker_entries: TRACKER_ROWS,
  thread_messages: THREAD_MESSAGES,
  intents: [{ user_id: SESSION_USER.id, stance: "have_team_looking_for_roles" }],
  teams: [
    {
      id: "team-0",
      name: ROOM_TEAMS[0]!.name,
      roles_needed: ROOM_TEAMS[0]!.roles_needed,
      max_size: 4,
      state: "open_for_roles",
      owner_user_id: "owner-0",
      opportunity_id: "opp-1",
      opportunities: { slug: "worst-case-1", title: worstCaseOpportunity(1).title },
    },
  ],
  team_members: [{ user_id: "owner-0" }],
  projects: [PROJECT_ROW, ...PUBLIC_PROJECTS],
  project_members: Array.from({ length: 5 }, (_, i) => ({
    user_id: `member-${i}`,
    is_owner: i === 0,
    joined_at: "2026-07-01T00:00:00Z",
    users: { display_name: `Member number ${i + 1}` },
    tags: { name: "frontend" },
  })),
  project_submissions: Array.from({ length: 4 }, (_, i) => ({
    opportunity_id: `opp-${i}`,
    outcome: ["submitted", "finalist", "winner", "not_selected"][i]!,
    recorded_at: "2026-08-01T00:00:00Z",
    opportunities: { slug: `worst-case-${i + 1}`, title: worstCaseOpportunity(i + 1).title },
  })),
  tags: TAG_VOCABULARY,
  categories: CATEGORY_VOCABULARY,
  organisation_members: [{ user_id: SESSION_USER.id, role: "owner" }],
  countries: COUNTRY_LIST,
  notification_preferences: [
    "deadline_reminder", "opportunity_changed", "opportunity_closed", "digest",
    "request_received", "team_update", "moderation_outcome",
  ].flatMap((type) =>
    ["telegram", "email"].map((channel) => ({ type, channel, enabled: true })),
  ),
  user_notification_settings: [
    { digest_frequency: "daily", quiet_hours_start: 21, quiet_hours_end: 7, paused_until: null },
  ],
  notification_channels: [
    { address: "555000111", verified_at: "2026-09-01T00:00:00Z", is_active: true, paused_until: null },
  ],
  eligibility_profiles: [{ user_id: SESSION_USER.id, country_of_residence: "ZW", birth_year: 1998 }],
  users: [
    {
      email: SESSION_USER.email,
      auth_provider: "github",
      timezone: SESSION_USER.timezone,
      low_data_mode: false,
      account_state: "active",
      deleted_at: null,
      created_at: "2026-06-01T00:00:00Z",
    },
  ],
};

/**
 * A chainable stub shaped like supabase-js, because the settings pages chain
 * differently from the tracker (.eq().eq().maybeSingle(), .upsert(), .delete()).
 *
 * Deliberately permissive about the ORDER of calls and strict about what comes
 * back: any chain resolves to the fixture rows for the table it started from, so a
 * page cannot accidentally render an empty state and pass its budget on nothing.
 */
function tableStub(table: string) {
  const rows = TABLE_ROWS[table] ?? [];
  const result = { data: rows, error: null };
  const single = { data: rows[0] ?? null, error: null };

  const chain: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
    maybeSingle: async () => single,
    single: async () => single,
  };
  // Every builder method any page reaches for. A MISSING one is not a harmless gap: the page
  // throws, catches its own failure, renders an error state, and measures small — a budget
  // passed on a page that never rendered. The projects browse page did exactly that until
  // `neq` was added here, which is why the guard below also asserts a known string per route.
  for (const method of [
    "select", "eq", "neq", "is", "in", "not", "or", "gt", "gte", "lt", "lte",
    "like", "ilike", "contains", "overlaps", "textSearch", "range",
    "order", "limit", "update", "upsert", "delete", "insert",
  ]) {
    chain[method] = () => chain;
  }
  return chain;
}

// The authenticated pages redirect without a session, so their budgets could never
// be measured on the real page. Mocking auth is what lets them be measured at all
// -- an unmeasured route is an unenforced budget.
/**
 * The dashboard's two surfaces come back through rpc(). Filled to their caps, because a
 * budget measured against an empty personal surface would prove nothing — and §14.1 and
 * §14.2 exist precisely to cap what these can cost.
 */
const WINDOW_ROWS = Array.from({ length: 8 }, (_, i) => ({
  source: "recommendations",
  slug: `worst-case-${i + 1}`,
  title: worstCaseOpportunity(i + 1).title,
  deadline_at: worstCaseOpportunity(i + 1).deadline_at,
  deadline_precision: "date_only",
  is_rolling: false,
  cost: "free",
  organisation_name: "Example Foundation for African Innovation",
  category_name: "AI challenge",
  verdict: "eligible",
  reasons: ["Zimbabwe eligible", "within the age range", "Python and ML match your interests", "closes in 5 days"],
}));

const ACTION_ROWS = Array.from({ length: 5 }, (_, i) => ({
  kind: `action-${i}`,
  headline: `Finish your application: ${worstCaseOpportunity(i + 1).title}`,
  reason: "You saved this and it closes in 2 days.",
  href: `/opportunities/worst-case-${i + 1}`,
  priority: i + 1,
}));

vi.mock("../src/lib/auth", () => ({
  getSessionUser: vi.fn(async () => SESSION_USER),
  getResidenceCountry: vi.fn(async () => "ZW"),
  createAuthClient: vi.fn(() => ({
    from: (table: string) => tableStub(table),
    rpc: async (fn: string) =>
      fn === "your_window"
        ? { data: WINDOW_ROWS, error: null }
        : fn === "next_actions_capped"
          ? { data: ACTION_ROWS, error: null }
          : fn in ROOM_RPC
            ? { data: ROOM_RPC[fn], error: null }
            : { data: null, error: null },
  })),
  personalWritesAllowed: vi.fn(() => true),
  socialWritesAllowed: vi.fn(() => ({ allowed: true, reason: null })),
  safeReturnTo: (v: string | null) => v ?? "/",
}));

/**
 * The list page's hybrid-search path, with a query. Mocked so the budget covers the
 * compiled-chip row: §7's chips are rendered markup and have to be measured, and the
 * fixture query below is deliberately one the heuristic maps completely (four chips) so
 * the measurement is of the worst realistic case rather than the empty one.
 */
vi.mock("../src/lib/search", () => ({
  search: vi.fn(async () => ({
    ok: true,
    rows: PAGE_OF_ROWS.map((row) => ({
      id: row.id,
      slug: row.slug,
      score: 1,
      verdict: "eligible",
      verification: "verified",
      deadline_at: row.deadline_at,
      is_rolling: false,
      organisation_slug: "example-org",
      category_code: "ai_challenge",
    })),
    compiled: {
      chips: [
        { kind: "country", value: "ZW", label: "Open to Zimbabwe", from: "zimbabwe", source: "heuristic" },
        { kind: "category", value: "ai_challenge", label: "AI challenge", from: "ai challenges", source: "heuristic" },
        { kind: "mode", value: "online", label: "Online", from: "remote", source: "heuristic" },
        { kind: "deadline", value: "7", label: "Closing within a week", from: "closing soon", source: "heuristic" },
      ],
      keywords: "",
      unmapped: [],
    },
    retrieval: { fts: true, vector: true, compiler: "heuristic" },
  })),
  getQueryVocabulary: vi.fn(async () => ({ countries: [], categories: [] })),
  rank: vi.fn((rows: unknown[]) => rows),
}));

/**
 * The homepage's country and category links, at full size: §28 makes every African country a
 * first-class page, so the board carries all 54 and the byte budget has to cover them. Names
 * are the real ones — "Democratic Republic of the Congo" is 32 characters and there is no
 * point measuring a list of two-letter codes.
 */
const AFRICAN_COUNTRIES = [
  "Algeria", "Angola", "Benin", "Botswana", "Burkina Faso", "Burundi", "Cabo Verde",
  "Cameroon", "Central African Republic", "Chad", "Comoros", "Congo",
  "Democratic Republic of the Congo", "Djibouti", "Egypt", "Equatorial Guinea", "Eritrea",
  "Eswatini", "Ethiopia", "Gabon", "Gambia", "Ghana", "Guinea", "Guinea-Bissau",
  "Côte d'Ivoire", "Kenya", "Lesotho", "Liberia", "Libya", "Madagascar", "Malawi", "Mali",
  "Mauritania", "Mauritius", "Morocco", "Mozambique", "Namibia", "Niger", "Nigeria",
  "Rwanda", "São Tomé and Príncipe", "Senegal", "Seychelles", "Sierra Leone", "Somalia",
  "South Africa", "South Sudan", "Sudan", "Tanzania", "Togo", "Tunisia", "Uganda",
  "Zambia", "Zimbabwe",
];

const ENTRY_POINTS = {
  countries: AFRICAN_COUNTRIES.map((name, i) => ({
    iso2: `C${String(i).padStart(1, "0")}`.slice(0, 2),
    name,
    slug: name.toLowerCase().replace(/[^a-z]+/g, "-"),
  })),
  categories: [
    "Hackathon", "Innovation challenge", "Grant", "Fellowship", "Scholarship", "Accelerator",
    "Incubator", "Competition", "Residency", "Research call", "Award", "Bootcamp",
  ].map((name) => ({
    code: name.toLowerCase().replace(/ /g, "_"),
    name,
    slug: name.toLowerCase().replace(/ /g, "-"),
  })),
};

vi.mock("../src/lib/db", () => ({
  getOpportunity: vi.fn(async () => ({ ok: true, data: DETAIL })),
  getCountry: vi.fn(async (iso2: string | null) =>
    iso2 ? { iso2, name: "Zimbabwe", slug: "zimbabwe" } : null,
  ),
  getEntryPoints: vi.fn(async () => ENTRY_POINTS),
  getLastVerifiedAt: vi.fn(async () => "2026-09-14T06:00:00Z"),
  searchOpportunities: vi.fn(async () => ({
    ok: true,
    data: { rows: PAGE_OF_ROWS, total: 137 },
  })),
  listOpportunities: vi.fn(async () => ({ ok: true, data: PAGE_OF_ROWS })),
  getOrganisation: vi.fn(async () => ({ ok: true, data: ORGANISATION })),
  getTracker: vi.fn(async () => ({ ok: true, data: TRACKER_ROWS })),
  getRuleTypeCounts: vi.fn(async () => ({ country_in: 42, age_between: 17 })),
  allowedTrackerTransitions: vi.fn(async () => ["applied"]),
  getPublishedCount: vi.fn(async () => 312),
  isFlagEnabled: vi.fn(async () => false),
  // The unsubscribe page reads through this. Returning a real-looking token means
  // the page renders its decision state, which is the state with content in it.
  getOpportunitiesByIds: vi.fn(async () => PAGE_OF_ROWS),
  getClient: vi.fn(() => ({
    from: (table: string) => tableStub(table),
    rpc: async (fn: string) =>
      fn === "describe_unsubscribe_token"
        ? { data: [{ type: "digest", already_used: false, digest_frequency: "daily" }], error: null }
        : fn in ROOM_RPC
          ? { data: ROOM_RPC[fn], error: null }
          : { data: null, error: null },
  })),
}));

const gz = (s: string | Buffer) => gzipSync(Buffer.from(s), { level: 9 }).length;
const fmt = (n: number) => `${(n / KB).toFixed(1)} KB`;

/**
 * Client-side asset weight, measured from the REAL build output.
 *
 * Why not from the rendered HTML: the container API renders a page but does not
 * resolve island hydration assets, so the HTML it returns carries no script or
 * link tags. An earlier version of this test scanned the HTML, found 0 modules,
 * measured 0 KB of JS and PASSED — a false pass of exactly the kind this test
 * exists to prevent.
 *
 * So the whole built client bundle is charged to every route, as a deliberate
 * UPPER BOUND. Islands share the Svelte runtime, so this can only over-estimate,
 * and a new island that pushes the shared bundle over a budget fails the build
 * rather than slipping through unattributed.
 */
function measureBuiltAssets(): {
  islandJs: number;
  pageScriptJs: number;
  css: number;
  islandModules: number;
  pageScriptModules: number;
} {
  const assetDir = join(CLIENT_DIR, "_a");
  const empty = {
    islandJs: 0,
    pageScriptJs: 0,
    css: 0,
    islandModules: 0,
    pageScriptModules: 0,
  };
  if (!existsSync(assetDir)) return empty;

  const totals = { ...empty };
  for (const entry of readdirSync(assetDir)) {
    const file = join(assetDir, entry);
    if (entry.endsWith(".css")) {
      totals.css += gz(readFileSync(file));
      continue;
    }
    if (!entry.endsWith(".js")) continue;

    // A page <script> is built as its own chunk, named after the page. It shares
    // nothing with the island runtime, so charging a counter script the 15 KB Svelte
    // runtime would fail a budget on bytes the route never sends. The two are summed
    // separately and charged separately.
    if (/astro_type_script/.test(entry)) {
      totals.pageScriptJs += gz(readFileSync(file));
      totals.pageScriptModules += 1;
    } else {
      totals.islandJs += gz(readFileSync(file));
      totals.islandModules += 1;
    }
  }
  return totals;
}

interface Measured {
  html: string;
  htmlBytes: number;
  total: number;
  js: number;
  css: number;
  modules: number;
  hydrates: boolean;
}

const measured: Record<string, Measured> = {};

/**
 * Page-script bytes found in the build, recorded so the vacuity check can fail when a
 * route claims to ship a script and the build contains none — which is what happens if
 * Astro starts inlining page scripts again (see astro.config.mjs) and the CSP silently
 * stops them running.
 */
let pageScriptBytes = 0;
let pageScriptModules = 0;

/** §10's low-data measurement is of a route that already has a budget, so it is keyed apart. */
type MeasureKey = keyof typeof BUDGETS | "lowDataList";

async function render(
  key: MeasureKey,
  importer: () => Promise<{ default: unknown }>,
  params: Record<string, string>,
  url: string,
  /**
   * Charge this route the client bundle even though it mounts no island.
   *
   * Two Phase 5 routes ship a bundled `<script>` rather than an island — a character
   * counter and the thread poller. The container API resolves neither islands nor script
   * assets, so `astro-island` is absent from the HTML and the JS would otherwise be
   * measured as zero: the exact false pass the comment above warns about. Passing the flag
   * makes the charge a deliberate decision rather than an inference from markup the
   * container does not produce.
   */
  shipsScript = false,
  /** Request headers, for the low-data variant. DESIGN_SYSTEM.md §10 is read server-side. */
  headers: Record<string, string> = {},
) {
  const container = await AstroContainer.create();
  container.addServerRenderer({ name: "@astrojs/svelte", renderer: svelteRenderer });
  container.addClientRenderer({
    name: "@astrojs/svelte",
    entrypoint: "@astrojs/svelte/client.js",
  });

  const { default: Page } = await importer();
  const response = await container.renderToResponse(Page as never, {
    params,
    locals: { runtime: { env: {} } },
    request: new Request(url, { headers }),
  });

  const html = await response.text();
  const assets = measureBuiltAssets();
  const htmlBytes = gz(html);
  pageScriptBytes = assets.pageScriptJs;
  pageScriptModules = assets.pageScriptModules;

  // A route with no island ships no JS at all, so charging it the shared bundle
  // would be conservative past the point of usefulness — the organisation page
  // would sit at 76% of a budget it does not spend, and a later island would
  // fail it spuriously. Routes WITH an island are still charged the whole bundle
  // as an upper bound, since islands share the Svelte runtime.
  const island = html.includes("astro-island");
  const hydrates = island || shipsScript;
  const js = (island ? assets.islandJs : 0) + (shipsScript ? assets.pageScriptJs : 0);
  const modules = (island ? assets.islandModules : 0) + (shipsScript ? assets.pageScriptModules : 0);

  measured[key] = {
    html,
    htmlBytes,
    js,
    css: assets.css,
    modules,
    total: htmlBytes + assets.css + js,
    hydrates,
  };
}

beforeAll(async () => {
  // The JS half reads the built client output, so a build must have run. Failing
  // loudly beats silently measuring 0 KB and calling it a pass.
  expect(
    existsSync(CLIENT_DIR),
    `No build output at ${CLIENT_DIR}. Run the build before this test.`,
  ).toBe(true);

  await render(
    "detail",
    () => import("../src/pages/opportunities/[slug].astro"),
    { slug: "worst-case-1" },
    "https://example.invalid/opportunities/worst-case-1",
  );
  await render(
    "list",
    () => import("../src/pages/opportunities/index.astro"),
    {},
    // With a query, so the compiled-chip row is measured too.
    "https://example.invalid/opportunities?q=remote+ai+hackathons+in+zimbabwe+closing+soon",
  );
  await render("homepage", () => import("../src/pages/index.astro"), {}, "https://example.invalid/");
  /**
   * The same list page in low-data mode. DESIGN_SYSTEM.md §10 sets a target of 40 KB for it,
   * which is a different number from the route budget and belongs to a different promise: the
   * route budget is what the page may cost anybody, and this is what it costs the reader who
   * told us they are paying by the megabyte.
   */
  await render(
    "lowDataList",
    () => import("../src/pages/opportunities/index.astro"),
    {},
    "https://example.invalid/opportunities",
    false,
    { cookie: "ld=1" },
  );
  await render(
    "tracker",
    () => import("../src/pages/tracker.astro"),
    {},
    "https://example.invalid/tracker",
  );
  await render(
    "organisation",
    () => import("../src/pages/organisations/[slug].astro"),
    { slug: "example-org" },
    "https://example.invalid/organisations/example-org",
  );
  await render(
    "notifications",
    () => import("../src/pages/you/notifications.astro"),
    {},
    "https://example.invalid/you/notifications",
  );
  await render(
    "account",
    () => import("../src/pages/you/account.astro"),
    {},
    "https://example.invalid/you/account",
  );
  await render(
    "dashboard",
    () => import("../src/pages/you/index.astro"),
    {},
    "https://example.invalid/you",
  );
  await render(
    "room",
    () => import("../src/pages/opportunities/[slug]/room.astro"),
    { slug: "worst-case-1" },
    "https://example.invalid/opportunities/worst-case-1/room",
  );
  await render(
    "intent",
    () => import("../src/pages/opportunities/[slug]/intent.astro"),
    { slug: "worst-case-1" },
    "https://example.invalid/opportunities/worst-case-1/intent",
  );
  await render(
    "teamNew",
    () => import("../src/pages/opportunities/[slug]/teams/new.astro"),
    { slug: "worst-case-1" },
    "https://example.invalid/opportunities/worst-case-1/teams/new",
  );
  await render(
    "requests",
    () => import("../src/pages/requests/index.astro"),
    {},
    "https://example.invalid/requests",
  );
  await render(
    "compose",
    () => import("../src/pages/requests/new.astro"),
    {},
    "https://example.invalid/requests/new?team=team-0",
    true,
  );
  await render(
    "threads",
    () => import("../src/pages/threads/index.astro"),
    {},
    "https://example.invalid/threads",
  );
  await render(
    "thread",
    () => import("../src/pages/threads/[id].astro"),
    { id: "thread-0" },
    "https://example.invalid/threads/thread-0",
    true,
  );
  await render(
    "projectBrowse",
    () => import("../src/pages/projects/index.astro"),
    {},
    "https://example.invalid/projects",
  );
  await render(
    "projectNew",
    () => import("../src/pages/projects/new.astro"),
    {},
    "https://example.invalid/projects/new",
  );
  await render(
    "projectDetail",
    () => import("../src/pages/projects/[slug].astro"),
    { slug: PROJECT_ROW.slug },
    `https://example.invalid/projects/${PROJECT_ROW.slug}`,
  );
  await render(
    "projectEdit",
    () => import("../src/pages/projects/[slug]/edit.astro"),
    { slug: PROJECT_ROW.slug },
    `https://example.invalid/projects/${PROJECT_ROW.slug}/edit`,
  );
  await render(
    "myProjects",
    () => import("../src/pages/you/projects.astro"),
    {},
    "https://example.invalid/you/projects",
  );
  await render(
    "orgClaim",
    () => import("../src/pages/organisations/[slug]/claim.astro"),
    { slug: "example-org" },
    "https://example.invalid/organisations/example-org/claim",
  );
  await render(
    "orgManage",
    () => import("../src/pages/organisations/[slug]/manage.astro"),
    { slug: "example-org" },
    "https://example.invalid/organisations/example-org/manage",
  );
  await render(
    "submitPublic",
    () => import("../src/pages/submit.astro"),
    {},
    "https://example.invalid/submit",
  );
  await render(
    "adminDashboard",
    () => import("../src/pages/admin/index.astro"),
    {},
    "https://example.invalid/admin",
  );
  await render(
    "adminQueue",
    () => import("../src/pages/admin/queues/[queue].astro"),
    { queue: "low_confidence" },
    "https://example.invalid/admin/queues/low_confidence",
  );
  await render(
    "adminReports",
    () => import("../src/pages/admin/reports.astro"),
    {},
    "https://example.invalid/admin/reports",
  );
  await render(
    "adminUsers",
    () => import("../src/pages/admin/users.astro"),
    {},
    "https://example.invalid/admin/users",
  );
  await render(
    "adminSources",
    () => import("../src/pages/admin/sources.astro"),
    {},
    "https://example.invalid/admin/sources",
  );
  await render(
    "adminAudit",
    () => import("../src/pages/admin/audit.astro"),
    {},
    "https://example.invalid/admin/audit",
  );
  await render(
    "unsubscribe",
    () => import("../src/pages/unsubscribe.astro"),
    {},
    "https://example.invalid/unsubscribe?t=budget-fixture-token",
  );

  const pct = (n: number, of: number) => `${Math.round((n / of) * 100)}%`;
  const lines = Object.entries({
    ...BUDGETS,
    lowDataList: { label: "Low-data list (§10)", total: LOW_DATA_LIST_BUDGET, js: 0 },
  }).map(([key, budget]) => {
    const m = measured[key]!;
    return (
      `  ${budget.label.padEnd(28)} total ${fmt(m.total).padStart(9)} / ${fmt(budget.total)} (${pct(m.total, budget.total)})` +
      `   js ${fmt(m.js).padStart(8)} / ${fmt(budget.js)}${budget.js > 0 ? ` (${pct(m.js, budget.js)})` : ""}` +
      `   html ${fmt(m.htmlBytes)}${m.hydrates ? "" : "   (no island)"}`
    );
  });
  console.log("\n" + lines.join("\n") + "\n");
});

describe("byte budgets — on-demand routes (invariant 5)", () => {
  it("actually measured something (guards against a vacuous pass)", () => {
    // Zero must fail loudly. This is the specific bug that made an earlier
    // version of this test pass while measuring nothing at all.
    for (const [key, m] of Object.entries(measured)) {
      expect(m.css, `${key}: measured 0 bytes of CSS`).toBeGreaterThan(0);
      expect(m.htmlBytes, `${key}: rendered HTML is suspiciously small`).toBeGreaterThan(1024);
      if (m.hydrates) {
        expect(m.modules, `${key}: hydrates but found no JS modules`).toBeGreaterThan(0);
        expect(m.js, `${key}: hydrates but measured 0 bytes of JS`).toBeGreaterThan(0);
      }
    }

    // Two routes ship a bundled page script (the 500-character counter and the thread
    // poller). If the build contains no page-script chunk, either they stopped being
    // built or Astro inlined them into the HTML — where the strict CSP blocks them. Both
    // are silent failures in production only, so they fail here instead.
    expect(
      pageScriptModules,
      "no page-script chunk in the build: a route's <script> was inlined or dropped, and an inline module script is blocked by the CSP in public/_headers",
    ).toBeGreaterThanOrEqual(2);
    expect(pageScriptBytes, "page scripts measured 0 bytes").toBeGreaterThan(0);

    // At least one route must hydrate, otherwise the JS measurement is vacuous
    // across the board and the whole check proves nothing.
    expect(
      Object.values(measured).some((m) => m.hydrates),
      "no route hydrates — the JS budget is not being exercised at all",
    ).toBe(true);
  });

  for (const [key, budget] of Object.entries(BUDGETS)) {
    it(`${budget.label} stays within its JS budget`, () => {
      const m = measured[key]!;
      expect(m.js, `JS ${fmt(m.js)} of ${fmt(budget.js)} across ${m.modules} modules`).toBeLessThanOrEqual(
        budget.js,
      );
    });

    it(`${budget.label} stays within its total transfer budget`, () => {
      const m = measured[key]!;
      expect(
        m.total,
        `total ${fmt(m.total)} of ${fmt(budget.total)} (html ${fmt(m.htmlBytes)}, css ${fmt(m.css)}, js ${fmt(m.js)})`,
      ).toBeLessThanOrEqual(budget.total);
    });

    it(`${budget.label} ships no third-party script (invariant 12)`, () => {
      const external = [
        ...measured[key]!.html.matchAll(/<script[^>]+src=["'](https?:\/\/[^"']+)["']/g),
      ];
      expect(external.map((m) => m[1])).toEqual([]);
    });
  }

  it("keeps the low-data list page under DESIGN_SYSTEM.md §10's 40 KB", () => {
    const m = measured.lowDataList!;
    expect(
      m.total,
      `low-data list ${fmt(m.total)} of ${fmt(LOW_DATA_LIST_BUDGET)} (html ${fmt(m.htmlBytes)}, css ${fmt(m.css)}, js ${fmt(m.js)})`,
    ).toBeLessThanOrEqual(LOW_DATA_LIST_BUDGET);

    // And it must be the same page, lighter — not an error page, and not a page that lost its
    // rows. A 2 KB measurement of an empty list would pass this budget and mean nothing.
    expect(m.html).toContain("Open opportunities");
    expect(m.html).toContain("worst-case-1");
    expect(m.html).toContain("Low-data mode is on");
    expect(m.htmlBytes).toBeLessThan(measured.list!.htmlBytes);
  });

  it("renders the real closing board on the homepage, not the placeholder", () => {
    // The homepage was a Phase 0 placeholder for eight phases. A budget measured against that
    // page would have been meaningless, and so would one measured against an empty board.
    const html = measured.homepage!.html;
    expect(html).toContain("Closing soonest");
    expect(html).toContain("worst-case-1");
    expect(html).toContain("Board as of");
    // All 54 countries and every category are links on it, which is most of its weight.
    expect(html).toContain("Democratic Republic of the Congo");
    expect(html).not.toContain("The catalogue is being built");
  });

  it("mounts the eligibility island on the detail page", () => {
    // If the island stops rendering, the JS budget passes trivially while the
    // product loses its core interaction.
    expect(measured.detail!.html).toContain("astro-island");
    expect(measured.detail!.html).toContain("Check if you can apply");
  });

  it("renders the real settings pages, not an error or empty state", () => {
    // Same discipline as the tracker assertion below: a page that fell back to an
    // error state would sail under its budget and prove nothing.
    const notifications = measured.notifications!.html;
    // NOTIFICATIONS.md §8 requires the caps stated visibly on this page.
    expect(notifications).toContain("one digest a day");
    expect(notifications).toContain("three other messages");
    expect(notifications).toContain("When something I saved is about to close");
    // The fixture has Telegram linked, so the unlink control must be the one shown.
    expect(notifications).toContain("Unlink Telegram");
    // §9: no switch for security messages.
    expect(notifications).not.toContain('name="pref:security:email"');

    const account = measured.account!.html;
    expect(account).toContain("Download everything");
    expect(account).toContain("Type DELETE to confirm");
    // PRIVACY_AND_COMPLIANCE.md §5: the 30-day timeline stated in advance.
    expect(account).toContain("destroyed 30 days later");
    // §8: the eligibility profile goes immediately, and the page says so.
    expect(account).toContain("destroyed immediately, not in 30 days");
  });

  it("offers reducing frequency as an equal-weight option on unsubscribe", () => {
    // NOTIFICATIONS.md §9: "The unsubscribe confirmation page offers 'reduce
    // frequency instead' as an EQUAL-WEIGHT option." Both are the same button.
    const html = measured.unsubscribe!.html;
    expect(html).toContain("Send it weekly instead");
    expect(html).toContain("Stop the digest");
    const primaryButtons = [...html.matchAll(/bg-brand[^"]*"[^>]*>\s*(?:Stop|Send)/g)];
    expect(primaryButtons.length).toBe(2);
  });

  it("never unsubscribes on a GET (mail scanners follow links)", () => {
    // The page must be a decision, not an action: it renders forms that POST.
    expect(measured.unsubscribe!.html).toContain('method="post"');
    expect(measured.unsubscribe!.html).not.toContain("no more the digest");
  });

  it("shows the quoted source sentence and the raw deadline string", () => {
    // PRODUCT_SPEC.md §12.4 and §11.3.
    expect(measured.detail!.html).toContain(LONG_QUOTE.slice(0, 60));
    expect(measured.detail!.html).toMatch(/Applications close \d+ September/);
  });

  it("caps the personal surfaces at what §14 promises", () => {
    // §14.1 caps "Your window" at 8 and §14.2 the action list at 5. The caps are the
    // product decision — a feed optimises for time spent, these optimise for something
    // being done — so they are asserted rather than trusted.
    const html = measured.dashboard!.html;
    expect(html).toContain("Your window");
    expect(html).toContain("What to do next");
    // Every reason is rendered, because §14.2 requires each item to state one.
    expect(html).toContain("You saved this and it closes in 2 days.");
    // §14.3 [PR]: the explanation is templated, never free-generated.
    expect(html).toContain("Python and ML match your interests");
    // Never more than the caps, however many rows the query returned.
    expect([...html.matchAll(/Finish your application/g)]).toHaveLength(5);
  });

  it("shows the compiled query chips, editable", () => {
    // AI_SYSTEM.md §7 `[PR]`: "The user always sees and can edit the chips." Editing has
    // to work without JavaScript, so each chip is a link.
    const html = measured.list!.html;
    expect(html).toContain("We read that as");
    expect(html).toContain("Open to Zimbabwe");
    expect(html).toContain("Closing within a week");
    // Each chip removes itself by linking to the same search with the others pinned.
    expect(html).toMatch(/href="\/opportunities\?[^"]*category=ai_challenge/);
  });

  it("offers an explicit 'show more' rather than infinite scroll", () => {
    // UX_FLOWS.md §3 marks this `[PR]`: infinite scroll on metered data spends
    // the user's money without asking.
    expect(measured.list!.html).toContain("Show 20 more");
  });

  it("renders a populated tracker, not the empty state", () => {
    // 2.6 KB of HTML for 30 entries would mean the empty state rendered and the
    // dashboard budget was measured against nothing. Assert the rows are really
    // there, the same discipline as the vacuous-pass guard.
    expect(measured.tracker!.html).not.toContain("Nothing saved yet");
    expect(measured.tracker!.html).toContain("Closing soon");
    const rowCount = [...measured.tracker!.html.matchAll(/Early-Career Builders 2026/g)].length;
    expect(rowCount, `expected 30 tracker rows, found ${rowCount}`).toBeGreaterThanOrEqual(30);
  });

  it("keeps past opportunities on the organisation page", () => {
    // OPPORTUNITY_INGESTION.md §5.4 — expired records are never deleted.
    expect(measured.organisation!.html).toContain("Past opportunities");
  });
});
