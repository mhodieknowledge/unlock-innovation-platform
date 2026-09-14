/**
 * The collaboration read layer. TEAM_FORMATION.md §3, COLLABORATION_SYSTEM.md §2–§4.
 *
 * Every call here goes through a function in migration 0017 rather than a table read, and
 * the reason is worth stating once: §2.2 `[PR]` fixes exactly what another builder's intent
 * exposes — "display name, country, headline, roles offered and the note. Nothing else,
 * ever" — and a page that selected from `users` to draw a builder card would need a policy
 * that exposes more than that. The functions return the permitted fields; this module is a
 * thin typed wrapper over them, so there is no second place where a field list is decided.
 *
 * Errors degrade to an empty result with `ok: false`, never a throw: invariant 10's spirit
 * is that a surface that cannot load says so rather than 500s, and a social surface that
 * fails closed shows nothing rather than a half-filled room.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type RoomStateName = "open" | "below_floor" | "archived" | "disabled" | "absent";

export interface RoomState {
  state: RoomStateName;
  intent_count: number;
  team_count: number;
  reason: string;
}

export type Stance =
  | "going_solo"
  | "looking_for_team"
  | "have_team_looking_for_roles"
  | "just_interested";

/** TEAM_FORMATION.md §2.1's table, in the order it is offered to a user. */
export const STANCES: readonly { value: Stance; label: string; meaning: string }[] = [
  {
    value: "looking_for_team",
    label: "I'm looking for a team",
    meaning: "You'll be listed for others going for this, with your roles and note.",
  },
  {
    value: "have_team_looking_for_roles",
    label: "I have a team and need people",
    meaning: "You'll be listed, and you can start a team page others can ask to join.",
  },
  {
    value: "going_solo",
    label: "I'm entering alone",
    meaning: "Counted only. Nobody sees your name.",
  },
  {
    value: "just_interested",
    label: "I'm just watching this one",
    meaning: "Counted only. Nobody sees your name.",
  },
];

export const LISTED_STANCES: readonly Stance[] = [
  "looking_for_team",
  "have_team_looking_for_roles",
];

export interface RoomBuilder {
  user_id: string;
  display_name: string | null;
  country_iso2: string | null;
  headline: string | null;
  roles_offered: string[];
  note: string | null;
  stance: Stance;
  leads_a_team: boolean;
  request_state: string | null;
}

export interface RoomTeam {
  team_id: string;
  name: string;
  pitch: string | null;
  roles_needed: string[];
  member_count: number;
  max_size: number;
  countries: string[];
  state: string;
  owner_user_id: string;
  owner_display_name: string | null;
  owner_stale: boolean;
  i_am_member: boolean;
  i_own_it: boolean;
  my_request_state: string | null;
}

export interface MyRoomStatus {
  stance: Stance | null;
  roles_offered: string[];
  note: string | null;
  intent_expires_at: string | null;
  my_team_id: string | null;
  my_team_name: string | null;
  i_own_my_team: boolean | null;
  requests_in: number;
  requests_out: number;
}

/**
 * §2.4's limits, as the compose page needs them BEFORE a form is shown.
 *
 * `blocked_reason` is the sentence to show when nothing can be sent — and it is the same
 * sentence the INSERT would raise, because both come from request_allowance_for() in
 * migration 0017. IMPLEMENTATION_PLAN.md §7's fifth `[PR]` criterion is that the limits are
 * "enforced and visible", and two copies of a number is how that stops being true.
 */
export interface RequestAllowance {
  day_used: number;
  day_limit: number;
  hour_used: number;
  hour_limit: number;
  pending_used: number;
  pending_limit: number;
  next_slot_at: string | null;
  blocked_reason: string | null;
}

export interface RequestRow {
  request_id: string;
  context: "team_request" | "project_role" | "opportunity_intent";
  state: string;
  role: string | null;
  message: string | null;
  created_at: string;
  expires_at: string;
  counterpart_user_id: string;
  counterpart_display_name: string | null;
  counterpart_country: string | null;
  counterpart_headline: string | null;
  counterpart_roles: string[];
  opportunity_slug: string | null;
  opportunity_title: string | null;
  team_id: string | null;
  team_name: string | null;
}

export interface ThreadRow {
  thread_id: string;
  state: string;
  closed_reason: string | null;
  last_message_at: string | null;
  created_at: string;
  counterpart_display_name: string | null;
  context_label: string;
  opportunity_slug: string | null;
  unread_from_them: boolean;
}

export interface ThreadHeader {
  thread_id: string;
  state: string;
  closed_reason: string | null;
  counterpart_user_id: string;
  counterpart_display_name: string | null;
  context_label: string;
  opportunity_slug: string | null;
  handoff_state: "proposed" | "accepted" | null;
  handoff_channel: string | null;
  handoff_proposal_id: string | null;
  handoff_is_mine: boolean | null;
}

export interface ThreadMessage {
  id: string;
  sender_user_id: string;
  body: string;
  created_at: string;
}

/** The channels §3.3 hands off to, and nothing else. */
export const HANDOFF_CHANNELS = ["telegram", "whatsapp", "email"] as const;
export type HandoffChannel = (typeof HANDOFF_CHANNELS)[number];

const firstRow = <T>(data: unknown): T | null =>
  Array.isArray(data) ? ((data[0] as T) ?? null) : ((data as T) ?? null);

/**
 * The room's state, for anyone — including a signed-out reader, because the opportunity
 * page needs it to decide between an entry point and a CTA.
 *
 * Fails CLOSED: any error reads as `disabled`, which renders nothing. PRODUCT_SPEC.md §24
 * would rather a working surface disappear for a minute than an empty room appear for one.
 */
export async function getRoomState(
  client: SupabaseClient,
  opportunityId: string,
): Promise<RoomState> {
  const { data, error } = await client.rpc("room_state", { p_opportunity_id: opportunityId });
  const row = firstRow<RoomState>(data);
  if (error || !row) {
    return { state: "disabled", intent_count: 0, team_count: 0, reason: "unavailable" };
  }
  return row;
}

/** §2.3 `[PR]`: NULL below five, and NULL is not a number a template can print. */
export async function getIntentCount(
  client: SupabaseClient,
  opportunityId: string,
): Promise<number | null> {
  const { data, error } = await client.rpc("intent_count_public", {
    p_opportunity_id: opportunityId,
  });
  if (error || typeof data !== "number") return null;
  return data;
}

export async function getRoomBuilders(
  client: SupabaseClient,
  opportunityId: string,
): Promise<RoomBuilder[]> {
  const { data, error } = await client.rpc("room_builders", {
    p_opportunity_id: opportunityId,
  });
  if (error || !Array.isArray(data)) return [];
  return data as RoomBuilder[];
}

export async function getRoomTeams(
  client: SupabaseClient,
  opportunityId: string,
): Promise<RoomTeam[]> {
  const { data, error } = await client.rpc("room_teams", { p_opportunity_id: opportunityId });
  if (error || !Array.isArray(data)) return [];
  return data as RoomTeam[];
}

export async function getMyRoomStatus(
  client: SupabaseClient,
  opportunityId: string,
): Promise<MyRoomStatus | null> {
  const { data, error } = await client.rpc("my_room_status", {
    p_opportunity_id: opportunityId,
  });
  if (error) return null;
  return firstRow<MyRoomStatus>(data);
}

export async function getRequestAllowance(
  client: SupabaseClient,
): Promise<RequestAllowance | null> {
  const { data, error } = await client.rpc("request_allowance");
  if (error) return null;
  return firstRow<RequestAllowance>(data);
}

export async function getMyRequests(
  client: SupabaseClient,
  direction: "in" | "out",
): Promise<RequestRow[]> {
  const { data, error } = await client.rpc("my_requests", { p_direction: direction });
  if (error || !Array.isArray(data)) return [];
  return data as RequestRow[];
}

export async function getMyThreads(client: SupabaseClient): Promise<ThreadRow[]> {
  const { data, error } = await client.rpc("my_threads");
  if (error || !Array.isArray(data)) return [];
  return data as ThreadRow[];
}

export async function getThreadHeader(
  client: SupabaseClient,
  threadId: string,
): Promise<ThreadHeader | null> {
  const { data, error } = await client.rpc("thread_view", { p_thread_id: threadId });
  if (error) return null;
  return firstRow<ThreadHeader>(data);
}

export async function getThreadMessages(
  client: SupabaseClient,
  threadId: string,
): Promise<ThreadMessage[]> {
  const { data, error } = await client
    .from("thread_messages")
    .select("id, sender_user_id, body, created_at")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true })
    .limit(200);
  if (error || !data) return [];
  return data as unknown as ThreadMessage[];
}

/** After consent only. The gate is in the database (§3.3 `[PR]`); this just reads it. */
export async function getHandoffIdentifiers(
  client: SupabaseClient,
  threadId: string,
): Promise<{ channel: string; their_identifier: string } | null> {
  const { data, error } = await client.rpc("handoff_identifiers", { p_thread_id: threadId });
  if (error) return null;
  return firstRow<{ channel: string; their_identifier: string }>(data);
}

/**
 * §2.2 `[PR]`: "No attachments, no links in the first message (links are stripped and shown
 * as plain text until the connection is accepted — a standard anti-phishing measure)."
 *
 * Stripped here, in the request tier, on the way in — not rendered-around later. A stored
 * URL is one template away from being a live link, and the point of the rule is that a
 * stranger cannot put a clickable destination in front of you before you have agreed to
 * talk to them.
 *
 * The scheme and the dots go; the words stay, so a reader can still see what was meant.
 */
export function stripLinks(text: string): string {
  return text
    .replace(/\bhttps?:\/\/\S+/gi, (m) => `[link removed: ${m.replace(/^https?:\/\//i, "").replace(/[./]/g, " ")}]`)
    .replace(/\bwww\.\S+/gi, (m) => `[link removed: ${m.replace(/[./]/g, " ")}]`)
    .replace(/\b[\w.-]+\.(?:com|org|net|io|co|africa|dev|app|me|ly|gg)\b(?:\/\S*)?/gi,
      (m) => `[link removed: ${m.replace(/[./]/g, " ")}]`);
}

/**
 * A person's name as a room shows it.
 *
 * display_name is optional, and "Unnamed builder" is a better neighbour than a blank line
 * or a leaked handle — §2.2's list has no fallback identifier in it.
 */
export const builderName = (name: string | null | undefined): string =>
  name && name.trim() !== "" ? name : "A builder";
