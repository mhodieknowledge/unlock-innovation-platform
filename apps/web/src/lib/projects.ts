/**
 * Projects. COLLABORATION_SYSTEM.md §1.
 *
 * The one thing in here that carries a `[PR]` is the synchronous first-pass match: §1.2
 * says "on save the system computes an embedding and runs a synchronous first-pass match,
 * so the user sees matched open calls within seconds of creating the project. This
 * immediacy is the feature's hook."
 *
 * So `createProject` does not hand off to a queue and hope. It creates the row, tries for
 * an embedding, computes the matches with the SAME scorer the nightly batch uses
 * (packages/config's project-matching module), and stores them — before the redirect. If
 * the embedder is unavailable the match still happens: the database returns a neutral
 * similarity and the tag-overlap and urgency terms carry the first pass, which is the
 * difference between a degraded hook and no hook.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { scoreProjectMatches } from "@mbele/config";
import type { RuntimeEnv } from "./runtime";

export type ProjectState =
  | "idea"
  | "looking_for_collaborators"
  | "team_forming"
  | "building"
  | "testing"
  | "launched"
  | "completed"
  | "paused"
  | "archived";

export type ProjectVisibility = "private" | "unlisted" | "public";

/** §1.3's lifecycle, in the order it is offered. Transitions are manual, always. */
export const PROJECT_STATES: readonly { value: ProjectState; label: string }[] = [
  { value: "idea", label: "An idea" },
  { value: "looking_for_collaborators", label: "Looking for collaborators" },
  { value: "team_forming", label: "Team forming" },
  { value: "building", label: "Building" },
  { value: "testing", label: "Testing" },
  { value: "launched", label: "Launched" },
  { value: "completed", label: "Completed" },
  { value: "paused", label: "Paused" },
  { value: "archived", label: "Archived" },
];

export const PROJECT_VISIBILITIES: readonly {
  value: ProjectVisibility;
  label: string;
  meaning: string;
}[] = [
  {
    value: "private",
    label: "Private",
    meaning: "Only you and anyone you add. It still gets matched to open calls — that is the point.",
  },
  {
    value: "unlisted",
    label: "Unlisted",
    meaning: "Anyone with the link. Not listed anywhere, not indexed.",
  },
  {
    value: "public",
    label: "Public",
    meaning: "Visible to anyone here. Search engines only if you also tick indexable.",
  },
];

export interface ProjectRow {
  id: string;
  slug: string;
  owner_user_id: string;
  title: string;
  pitch: string | null;
  problem: string | null;
  solution: string | null;
  target_users: string | null;
  state: ProjectState;
  visibility: ProjectVisibility;
  indexable: boolean;
  category_ids: string[];
  industry_ids: string[];
  skill_ids: string[];
  technology_ids: string[];
  roles_needed: string[];
  repo_url: string | null;
  demo_url: string | null;
  docs_url: string | null;
  country_iso2: string | null;
  state_changed_at: string;
  last_activity_at: string;
  matched_at: string | null;
  created_at: string;
}

export interface ProjectMatch {
  opportunity_id: string;
  slug: string;
  title: string;
  organisation_name: string | null;
  deadline_at: string | null;
  deadline_precision: string;
  is_rolling: boolean;
  cost: string;
  verdict: string;
  score: number;
  rank: number;
  reasons: string[];
  tracked: boolean;
}

export interface ProjectBrowseState {
  state: "open" | "below_floor" | "disabled";
  public_projects: number;
  floor: number;
}

export interface RelatedProject {
  slug: string;
  title: string;
  pitch: string | null;
  state: ProjectState;
  roles_needed: string[];
  country_iso2: string | null;
}

export interface InterestTarget {
  project_id: string;
  slug: string;
  title: string;
  owner_user_id: string;
  owner_display_name: string | null;
  roles_needed: string[];
  already_member: boolean;
  my_request_state: string | null;
}

const PROJECT_FIELDS =
  `id, slug, owner_user_id, title, pitch, problem, solution, target_users, state, visibility,
   indexable, category_ids, industry_ids, skill_ids, technology_ids, roles_needed,
   repo_url, demo_url, docs_url, country_iso2, state_changed_at, last_activity_at,
   matched_at, created_at`;

const firstRow = <T>(data: unknown): T | null =>
  Array.isArray(data) ? ((data[0] as T) ?? null) : ((data as T) ?? null);

/**
 * A vector for a project, from Workers AI.
 *
 * No hard-coded model name — AI_SYSTEM.md §2 guardrail 6 `[PR]`: "No model name in
 * application code. Models are configuration rows." Unconfigured means this capability is
 * off, and off is a supported state here: the match still runs, on tags and urgency.
 *
 * The batch tier embeds the same text with the local bge-small model (scripts/embed.mjs).
 * Both are 384-dimensional, which is what lets one column hold either.
 */
export async function embedProjectText(
  text: string,
  runtime: RuntimeEnv,
): Promise<number[] | null> {
  const model = runtime.PROJECT_EMBEDDING_MODEL ?? runtime.QUERY_EMBEDDING_MODEL;
  if (!text.trim() || !runtime.AI || !model) return null;

  try {
    const result = (await runtime.AI.run(model, { text: [text.slice(0, 2000)] })) as {
      data?: number[][];
    };
    const vector = result?.data?.[0];
    if (!Array.isArray(vector) || vector.length !== 384) return null;
    return vector;
  } catch {
    return null;
  }
}

/**
 * What the embedder is given. The same fields scripts/embed.mjs uses, in the same order —
 * a project embedded one way in the request tier and another way overnight would move
 * around the ranking for no reason its owner could see.
 */
export function projectEmbeddingText(project: {
  title: string;
  pitch?: string | null;
  problem?: string | null;
  target_users?: string | null;
  country_iso2?: string | null;
}): string {
  return [project.title, project.pitch, project.problem, project.target_users, project.country_iso2]
    .filter((part): part is string => typeof part === "string" && part.trim() !== "")
    .join("\n")
    .slice(0, 2000);
}

/**
 * §1.5's match, computed and stored now.
 *
 * Returns the number of matches stored. Failure is not fatal and not hidden: the project
 * page says "we haven't matched this yet" rather than pretending there is nothing open.
 */
export async function refreshProjectMatches(
  client: SupabaseClient,
  projectId: string,
): Promise<number | null> {
  const { data, error } = await client.rpc("project_match_candidates", {
    p_project_id: projectId,
    p_limit: 200,
  });
  if (error || !Array.isArray(data)) return null;

  const rows = scoreProjectMatches(data as never[]);
  const { data: written, error: writeError } = await client.rpc("replace_project_matches", {
    p_project_id: projectId,
    p_rows: rows,
  });
  if (writeError) return null;
  return typeof written === "number" ? written : rows.length;
}

export async function getProjectMatches(
  client: SupabaseClient,
  projectId: string,
): Promise<ProjectMatch[]> {
  const { data, error } = await client.rpc("project_matches", { p_project_id: projectId });
  if (error || !Array.isArray(data)) return [];
  return (data as ProjectMatch[]).map((row) => ({
    ...row,
    reasons: Array.isArray(row.reasons) ? row.reasons : [],
  }));
}

export async function getProjectBySlug(
  client: SupabaseClient,
  slug: string,
): Promise<ProjectRow | null> {
  const { data, error } = await client
    .from("projects")
    .select(PROJECT_FIELDS)
    .eq("slug", slug)
    .is("deleted_at", null)
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as ProjectRow;
}

export async function getMyProjects(client: SupabaseClient): Promise<ProjectRow[]> {
  const { data, error } = await client
    .from("projects")
    .select(PROJECT_FIELDS)
    .is("deleted_at", null)
    .order("last_activity_at", { ascending: false })
    .limit(50);
  if (error || !data) return [];
  return data as unknown as ProjectRow[];
}

/** Fails CLOSED: any error reads as `disabled`, which renders no browse surface at all. */
export async function getProjectBrowseState(
  client: SupabaseClient,
): Promise<ProjectBrowseState> {
  const { data, error } = await client.rpc("project_browse_state");
  const row = firstRow<ProjectBrowseState>(data);
  if (error || !row) return { state: "disabled", public_projects: 0, floor: 40 };
  return row;
}

/** §1.6: nothing at all below three matching public projects. The floor is in the database. */
export async function getRelatedProjects(
  client: SupabaseClient,
  opportunityId: string,
): Promise<RelatedProject[]> {
  const { data, error } = await client.rpc("projects_for_opportunity", {
    p_opportunity_id: opportunityId,
  });
  if (error || !Array.isArray(data)) return [];
  return data as RelatedProject[];
}

export async function getInterestTarget(
  client: SupabaseClient,
  projectId: string,
): Promise<InterestTarget | null> {
  const { data, error } = await client.rpc("project_interest_target", {
    p_project_id: projectId,
  });
  if (error) return null;
  return firstRow<InterestTarget>(data);
}

export interface ProjectMember {
  user_id: string;
  is_owner: boolean;
  joined_at: string;
  display_name: string | null;
  role_name: string | null;
}

export async function getProjectMembers(
  client: SupabaseClient,
  projectId: string,
): Promise<ProjectMember[]> {
  const { data, error } = await client
    .from("project_members")
    .select("user_id, is_owner, joined_at, users(display_name), tags(name)")
    .eq("project_id", projectId)
    .order("joined_at", { ascending: true });
  if (error || !data) return [];
  return (data as unknown as {
    user_id: string;
    is_owner: boolean;
    joined_at: string;
    users: { display_name: string | null } | null;
    tags: { name: string } | null;
  }[]).map((row) => ({
    user_id: row.user_id,
    is_owner: row.is_owner,
    joined_at: row.joined_at,
    display_name: row.users?.display_name ?? null,
    role_name: row.tags?.name ?? null,
  }));
}

export interface ProjectSubmission {
  opportunity_id: string;
  outcome: string;
  recorded_at: string;
  slug: string | null;
  title: string | null;
}

export async function getProjectSubmissions(
  client: SupabaseClient,
  projectId: string,
): Promise<ProjectSubmission[]> {
  const { data, error } = await client
    .from("project_submissions")
    .select("opportunity_id, outcome, recorded_at, opportunities(slug, title)")
    .eq("project_id", projectId)
    .order("recorded_at", { ascending: false });
  if (error || !data) return [];
  return (data as unknown as {
    opportunity_id: string;
    outcome: string;
    recorded_at: string;
    opportunities: { slug: string; title: string } | null;
  }[]).map((row) => ({
    opportunity_id: row.opportunity_id,
    outcome: row.outcome,
    recorded_at: row.recorded_at,
    slug: row.opportunities?.slug ?? null,
    title: row.opportunities?.title ?? null,
  }));
}

/** The outcomes a person records themselves. §1.5's submissions row, in plain words. */
export const SUBMISSION_OUTCOMES: readonly { value: string; label: string }[] = [
  { value: "submitted", label: "Entered" },
  { value: "finalist", label: "Finalist" },
  { value: "winner", label: "Won" },
  { value: "not_selected", label: "Not selected" },
  { value: "withdrawn", label: "Withdrew" },
];

export const stateLabel = (state: ProjectState): string =>
  PROJECT_STATES.find((s) => s.value === state)?.label ?? state;
