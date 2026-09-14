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
import svelteRenderer from "@astrojs/svelte/server.js";
import { beforeAll, describe, expect, it, vi } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(HERE, "..", "dist", "client");
const KB = 1024;

/** PRODUCT_SPEC.md §25.1, for the routes that render on demand. */
const BUDGETS = {
  detail: { label: "Opportunity detail", total: 120 * KB, js: 30 * KB },
  list: { label: "Opportunity list / search", total: 150 * KB, js: 40 * KB },
  organisation: { label: "Organisation page", total: 120 * KB, js: 25 * KB },
  tracker: { label: "Authenticated dashboard", total: 200 * KB, js: 70 * KB },
  notifications: { label: "Notification settings", total: 200 * KB, js: 70 * KB },
  account: { label: "Account settings", total: 200 * KB, js: 70 * KB },
  // Not an authenticated route: someone reaches it from an email, often on the
  // worst connection they have. §25.1's "any route" ceiling is 250 KB, but a page
  // with two buttons on it has no business anywhere near that, so it is held to
  // the tightest budget in the table.
  unsubscribe: { label: "Unsubscribe", total: 100 * KB, js: 15 * KB },
  dashboard: { label: "Your window", total: 200 * KB, js: 70 * KB },
  // Phase 5's surfaces, each measured at the cap its own SQL enforces: 40 teams and 60
  // builders in a room, 100 requests, 50 threads, 200 messages. A room measured with three
  // teams in it would prove nothing about the room a successful launch produces.
  room: { label: "Team room", total: 150 * KB, js: 40 * KB },
  intent: { label: "Intent form", total: 100 * KB, js: 15 * KB },
  teamNew: { label: "Team form", total: 100 * KB, js: 15 * KB },
  requests: { label: "Requests", total: 150 * KB, js: 40 * KB },
  compose: { label: "Request composer", total: 100 * KB, js: 15 * KB },
  threads: { label: "Conversations", total: 120 * KB, js: 25 * KB },
  thread: { label: "One conversation", total: 120 * KB, js: 25 * KB },
  // Phase 6. The detail page is measured with ten matches and the edit page with the whole
  // tag vocabulary and every country in the select, which is the largest form in the
  // product.
  projectBrowse: { label: "Project browse", total: 150 * KB, js: 40 * KB },
  projectNew: { label: "New project", total: 100 * KB, js: 15 * KB },
  projectDetail: { label: "Project detail", total: 150 * KB, js: 40 * KB },
  projectEdit: { label: "Project edit", total: 150 * KB, js: 40 * KB },
  myProjects: { label: "Your projects", total: 200 * KB, js: 70 * KB },
} as const;

const LONG_QUOTE =
  "Applications are open to individuals who are resident in any African country at the time of submission, who are currently enrolled in or have recently completed a programme of study at a recognised institution, and who have not previously received funding under this scheme.";

const RULE_TYPES = [
  "country_in", "country_not_in", "nationality_in", "residency_required",
  "age_between", "student_status_in", "year_of_study_in", "institution_type_in",
  "experience_between", "language_required",
] as const;

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
  is_admin: false,
  admin_role: null,
  account_state: "active",
  age_confirmed_18: true,
  timezone: "Africa/Harare",
  low_data_mode: false,
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
  for (const method of ["select", "eq", "is", "in", "order", "limit", "update", "upsert", "delete", "insert"]) {
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

vi.mock("../src/lib/db", () => ({
  getOpportunity: vi.fn(async () => ({ ok: true, data: DETAIL })),
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

async function render(
  key: keyof typeof BUDGETS,
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
    request: new Request(url),
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
    "unsubscribe",
    () => import("../src/pages/unsubscribe.astro"),
    {},
    "https://example.invalid/unsubscribe?t=budget-fixture-token",
  );

  const pct = (n: number, of: number) => `${Math.round((n / of) * 100)}%`;
  const lines = Object.entries(BUDGETS).map(([key, budget]) => {
    const m = measured[key]!;
    return (
      `  ${budget.label.padEnd(28)} total ${fmt(m.total).padStart(9)} / ${fmt(budget.total)} (${pct(m.total, budget.total)})` +
      `   js ${fmt(m.js).padStart(8)} / ${fmt(budget.js)} (${pct(m.js, budget.js)})` +
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
