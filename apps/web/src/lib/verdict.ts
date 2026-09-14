/**
 * Verdict presentation. DESIGN_SYSTEM.md §3.3 and §6.
 *
 * "Colour is never the only carrier." Every verdict has a distinct glyph AND a
 * text label, so removing colour entirely leaves the interface fully usable —
 * which is also what makes it work for a colour-blind reader and in a
 * screen reader. Shared between the Astro page and the Svelte island so the
 * server-rendered and client-rendered verdicts cannot drift.
 */

export type Verdict = "eligible" | "likely_eligible" | "unclear" | "not_eligible" | "unknown";

export interface VerdictPresentation {
  glyph: string;
  label: string;
  /** Tailwind classes for ink and wash. Tokens only (DESIGN_SYSTEM.md §12). */
  ink: string;
  wash: string;
  rail: string;
  /** Longer sentence for the block heading. */
  summary: string;
}

export const VERDICTS: Record<Verdict, VerdictPresentation> = {
  eligible: {
    glyph: "●",
    label: "Eligible",
    ink: "text-eligible",
    wash: "bg-eligible-wash",
    rail: "bg-eligible",
    summary: "You meet every requirement we could check.",
  },
  likely_eligible: {
    glyph: "◐",
    label: "Likely eligible",
    ink: "text-likely",
    wash: "bg-likely-wash",
    rail: "bg-likely",
    summary: "You appear to qualify, but we are less certain of some rules.",
  },
  unclear: {
    glyph: "？",
    label: "Unclear",
    ink: "text-unclear",
    wash: "bg-unclear-wash",
    rail: "bg-unclear",
    summary: "We cannot say for certain. Here is exactly what is missing.",
  },
  not_eligible: {
    glyph: "✕",
    label: "Not eligible",
    ink: "text-noteligible",
    wash: "bg-noteligible-wash",
    rail: "bg-noteligible",
    summary: "At least one requirement rules you out.",
  },
  unknown: {
    glyph: "○",
    label: "Not checked",
    ink: "text-ink-3",
    wash: "bg-sunken",
    rail: "bg-line-strong",
    summary: "Add three details and we will check this for you.",
  },
};

export const RULE_OUTCOME_GLYPH: Record<string, string> = {
  pass: "●",
  fail: "✕",
  unknown: "？",
  unparsed: "○",
};

/**
 * Screen-reader sentence for a verdict. DESIGN_SYSTEM.md §8 gives the shape:
 * "Likely eligible. Three of four requirements met. One needs your birth year."
 */
export function verdictAnnouncement(
  verdict: Verdict,
  ruleOutcomes: readonly string[],
  missingFields: readonly string[],
): string {
  const parts = [VERDICTS[verdict].label + "."];
  const gating = ruleOutcomes.length;
  if (gating > 0) {
    const passed = ruleOutcomes.filter((o) => o === "pass").length;
    parts.push(`${passed} of ${gating} requirements met.`);
  }
  if (missingFields.length === 1) {
    parts.push(`One needs your ${fieldLabel(missingFields[0]!)}.`);
  } else if (missingFields.length > 1) {
    parts.push(`${missingFields.length} need more detail from you.`);
  }
  return parts.join(" ");
}

const FIELD_LABELS: Record<string, string> = {
  country_of_residence: "country",
  nationalities: "nationality",
  birth_year: "birth year",
  student_status: "student status",
  year_of_study: "year of study",
  institution_type: "institution type",
  years_experience: "years of experience",
  languages: "languages",
  gender: "optional gender field",
  can_travel: "willingness to travel",
  remote_only: "remote-only preference",
};

export const fieldLabel = (field: string): string => FIELD_LABELS[field] ?? field.replace(/_/g, " ");
