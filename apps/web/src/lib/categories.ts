/**
 * What kind of thing a category is, as a mark.
 *
 * Lived in pages/index.astro while the category grid was the only thing drawing one. The
 * opportunity card now needs the same answer — a listing with no `og:image` gets its
 * category's mark in the header panel — and a second copy of this map would drift the first
 * time a category was added to the taxonomy.
 *
 * DESIGN_SYSTEM.md §8: every one of these is decorative and `aria-hidden` at every call site.
 * The category NAME is always beside it in words; nothing here is the only carrier of
 * anything.
 */

/** The icons in components/Icon.astro that a category may resolve to. */
export type CategoryIcon = "code" | "award" | "briefcase" | "growth" | "book" | "you" | "categories";

const BY_CODE: Record<string, CategoryIcon> = {
  hackathon: "code",
  coding_competition: "code",
  ai_challenge: "code",
  data_competition: "code",
  innovation_challenge: "code",
  open_source_program: "code",
  grant: "award",
  fellowship: "award",
  scholarship: "award",
  internship: "briefcase",
  developer_program: "briefcase",
  startup_competition: "growth",
  pitch_competition: "growth",
  accelerator: "growth",
  incubator: "growth",
  entrepreneurship_program: "growth",
  research_opportunity: "book",
  conference_cfp: "book",
  bootcamp: "book",
  community_challenge: "you",
};

/**
 * The mark for a category code.
 *
 * Falls back to the generic one rather than to nothing: a category added to the taxonomy
 * tomorrow should render a card that looks finished, not a card with a hole in it.
 */
export function categoryIcon(code: string | null | undefined): CategoryIcon {
  return (code && BY_CODE[code]) || "categories";
}
