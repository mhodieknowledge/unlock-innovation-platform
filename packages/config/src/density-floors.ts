/**
 * PRODUCT_SPEC.md §24 — density floors, the anti-empty-room mechanism.
 *
 * Invariant 4: never render a social surface below its density floor.
 * IMPLEMENTATION_PLAN.md §16 rule 4 adds: "Absent, not empty."
 *
 * Every flag here defaults to **false**. A surface becomes visible only when its
 * flag is enabled AND its computed condition is met — both, never either. The
 * flag is the operator's kill switch (SECURITY.md §11 requires one on every
 * non-core surface); the condition is the density test.
 */

export type DensityFlagKey =
  | "intent_count_visible"
  | "team_room_entry"
  | "teams_list_in_room"
  | "builders_also_going"
  | "public_project_browse"
  | "global_builder_index"
  | "related_projects_on_opportunity";

export interface DensityFloor {
  key: DensityFlagKey;
  surface: string;
  /** Human-readable floor, shown in the admin density panel (ADMIN_SYSTEM.md §10). */
  floor: string;
  /** What the user sees below the floor. Never an empty list. */
  belowFloor: string;
  /**
   * Ships disabled. PRODUCT_SPEC.md §24 is a `[PR]`, and
   * SYSTEM_ARCHITECTURE.md §19 requires density-dependent surfaces to be able to
   * ship dark.
   */
  defaultEnabled: false;
}

export const DENSITY_FLOORS: readonly DensityFloor[] = [
  {
    key: "intent_count_visible",
    surface: "Intent count on an opportunity",
    floor: "≥5 active intents",
    belowFloor: "Count hidden entirely — not '0', not '2'",
    defaultEnabled: false,
  },
  {
    key: "team_room_entry",
    surface: "Team room entry point",
    floor: "≥3 active intents OR ≥1 team",
    belowFloor: "Opportunity page with a single 'Be the first to say you're going' CTA",
    defaultEnabled: false,
  },
  {
    key: "teams_list_in_room",
    surface: "Teams list inside a room",
    floor: "≥1 open team",
    belowFloor: "Solo-builder list only",
    defaultEnabled: false,
  },
  {
    key: "builders_also_going",
    surface: "'Builders also going for this'",
    floor: "≥5 discoverable builders",
    belowFloor: "Hidden",
    defaultEnabled: false,
  },
  {
    key: "public_project_browse",
    surface: "Public project browse",
    floor: "≥40 public projects platform-wide",
    belowFloor: "Route absent and nav item unrendered; projects stay private tools",
    defaultEnabled: false,
  },
  {
    key: "global_builder_index",
    surface: "Global builder index",
    floor: "≥250 public profiles AND ≥1,000 MAU",
    belowFloor: "Not built — the feature does not exist in the UI",
    defaultEnabled: false,
  },
  {
    key: "related_projects_on_opportunity",
    surface: "'Related projects' on an opportunity",
    floor: "≥3 matching public projects",
    belowFloor: "Hidden",
    defaultEnabled: false,
  },
];

/** Numeric thresholds, referenced by the SQL conditions and by tests. */
export const DENSITY_THRESHOLDS = {
  intentCountVisible: 5,
  teamRoomMinIntents: 3,
  teamRoomMinTeams: 1,
  teamsListMinOpenTeams: 1,
  buildersAlsoGoingMin: 5,
  publicProjectBrowseMin: 40,
  globalBuilderIndexMinProfiles: 250,
  globalBuilderIndexMinMau: 1000,
  relatedProjectsMin: 3,
} as const;

export const densityFloor = (key: DensityFlagKey): DensityFloor => {
  const found = DENSITY_FLOORS.find((f) => f.key === key);
  if (!found) throw new Error(`Unknown density flag: ${key}`);
  return found;
};
