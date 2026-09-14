export { BRAND, CONTACT, CRAWLER_USER_AGENT, NO_FEE_STATEMENT } from "./brand.mjs";

export {
  ABSOLUTE_BUDGET,
  FONT_BUDGET,
  ICON_SPRITE_BUDGET,
  LOGO_BUDGET,
  LOW_DATA_LIST_BUDGET,
  ROUTE_BUDGETS,
} from "./budgets.js";
export type { RouteBudget } from "./budgets.js";

export { HOST_PLATFORMS, hostPlatformFor } from "./host-platforms.js";
export { projectMatchReasons, scoreProjectMatches } from "./project-matching.mjs";
export type { HostPlatform } from "./host-platforms.js";

export {
  DENSITY_FLOORS,
  DENSITY_THRESHOLDS,
  densityFloor,
} from "./density-floors.js";
export type { DensityFlagKey, DensityFloor } from "./density-floors.js";

export {
  ACTIVE_USER_DAYS,
  CANDIDATES_PER_RETRIEVER,
  DIVERSITY,
  ELIGIBILITY_BOOST,
  FRESHNESS_PENALTY,
  RECOMMENDATIONS_STORED,
  RECOMMENDATION_HORIZON_DAYS,
  PROJECT_MATCHES_STORED,
  PROJECT_MATCH_WEIGHTS,
  RECOMMENDATION_WEIGHTS,
  RRF_K,
  SURFACE_CAPS,
  URGENCY,
  VERIFICATION_QUALITY,
  TAG_OVERLAP_SATURATION,
  applyDiversity,
  capPerOrganisation,
  rrfScore,
  tagOverlapScore,
  urgencyBoost,
} from "./ranking.mjs";

export {
  QUERY_CACHE_TTL_SECONDS,
  compileQueryHeuristically,
  mergeModelChips,
  queryCacheKey,
} from "./query-compiler.js";
export type { CompiledQuery, QueryChip, QueryVocabulary } from "./query-compiler.js";
