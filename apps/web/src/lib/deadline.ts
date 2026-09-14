/**
 * Deadline state derivation. PRODUCT_SPEC.md §11.3.
 *
 * Derived, NEVER stored as a status — it depends on now() (DATA_MODEL.md §13).
 *
 * The conservative-display rule is the subtle part. When precision is coarser
 * than exact_time, "closes September 30" is treated as expiring at the START of
 * 30 September, not the end. A user who trusts us and applies on the 30th only
 * to find it shut is exactly the trust failure the freshness promise exists to
 * prevent, so we under-promise the window rather than over-promise it.
 */

export type DeadlinePrecision =
  | "exact_time"
  | "date_only"
  | "month_only"
  | "rolling"
  | "unknown";

export type DeadlineState =
  | "closing_today"
  | "closing_in_2_days"
  | "closing_this_week"
  | "closing_this_month"
  | "open"
  | "opens_soon"
  | "rolling"
  | "closed"
  | "unknown";

export interface DeadlineInput {
  deadline_at: string | Date | null | undefined;
  deadline_precision?: DeadlinePrecision | null;
  opens_at?: string | Date | null;
  is_rolling?: boolean | null;
}

export interface DeadlineFacts {
  state: DeadlineState;
  /** Null when there is no usable deadline. Negative once past. */
  daysRemaining: number | null;
  /** The instant we treat as the cutoff, after conservative adjustment. */
  effectiveAt: Date | null;
  /**
   * True when we narrowed the deadline because the source was imprecise. The UI
   * shows `deadline_raw` alongside, so the user sees what the source said.
   */
  narrowed: boolean;
}

const DAY_MS = 86_400_000;

const asDate = (v: string | Date | null | undefined): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Conservative cutoff for an imprecise deadline.
 *   exact_time  — as stated
 *   date_only   — start of the stated day
 *   month_only  — start of the stated month's first day
 */
function conservativeCutoff(at: Date, precision: DeadlinePrecision): { at: Date; narrowed: boolean } {
  switch (precision) {
    case "date_only":
      return {
        at: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())),
        narrowed: true,
      };
    case "month_only":
      return { at: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)), narrowed: true };
    case "exact_time":
    default:
      return { at, narrowed: false };
  }
}

export function deadlineFacts(input: DeadlineInput, now: Date = new Date()): DeadlineFacts {
  if (input.is_rolling || input.deadline_precision === "rolling") {
    return { state: "rolling", daysRemaining: null, effectiveAt: null, narrowed: false };
  }

  const deadline = asDate(input.deadline_at);
  if (!deadline || input.deadline_precision === "unknown" || !input.deadline_precision) {
    // An unknown deadline is stated as unknown, not guessed at.
    return {
      state: deadline ? "open" : "unknown",
      daysRemaining: null,
      effectiveAt: deadline,
      narrowed: false,
    };
  }

  const { at: effectiveAt, narrowed } = conservativeCutoff(deadline, input.deadline_precision);
  const msRemaining = effectiveAt.getTime() - now.getTime();
  const daysRemaining = Math.floor(msRemaining / DAY_MS);

  if (msRemaining <= 0) {
    return { state: "closed", daysRemaining, effectiveAt, narrowed };
  }

  const opensAt = asDate(input.opens_at);
  if (opensAt && opensAt.getTime() > now.getTime()) {
    return { state: "opens_soon", daysRemaining, effectiveAt, narrowed };
  }

  let state: DeadlineState;
  if (msRemaining < DAY_MS) state = "closing_today";
  else if (daysRemaining <= 2) state = "closing_in_2_days";
  else if (daysRemaining <= 7) state = "closing_this_week";
  else if (daysRemaining <= 31) state = "closing_this_month";
  else state = "open";

  return { state, daysRemaining, effectiveAt, narrowed };
}

/**
 * DESIGN_SYSTEM.md §2.2: the countdown's weight is a function of urgency,
 * interpolated on the variable font's weight axis. >30 days -> 400, 7 days ->
 * 550, <=48h -> 700. The number physically thickens as the deadline approaches;
 * this is the one piece of expressive typography in the system and it carries
 * real information.
 */
export function countdownWeight(daysRemaining: number | null): number {
  if (daysRemaining === null) return 400;
  if (daysRemaining <= 2) return 700;
  if (daysRemaining <= 7) return 550;
  if (daysRemaining <= 30) return 475;
  return 400;
}

/** Screen-reader and visible text. DESIGN_SYSTEM.md §8: countdowns read as text. */
export function countdownLabel(facts: DeadlineFacts): string {
  switch (facts.state) {
    case "rolling":
      return "Rolling deadline";
    case "unknown":
      return "Deadline not stated";
    case "closed":
      return "Closed";
    case "closing_today":
      return "Closes today";
    case "opens_soon":
      return "Not open yet";
    default: {
      const d = facts.daysRemaining;
      if (d === null) return "Open";
      return d === 1 ? "1 day left" : `${d} days left`;
    }
  }
}

/** MODERATION_AND_TRUST.md §1: we never show a badge without a date. */
export function freshnessLabel(lastVerifiedAt: string | Date | null | undefined, now: Date = new Date()): string {
  const at = asDate(lastVerifiedAt);
  if (!at) return "Not yet verified";
  const days = Math.floor((now.getTime() - at.getTime()) / DAY_MS);
  if (days <= 0) return "Checked today";
  if (days === 1) return "Checked yesterday";
  return `Checked ${days} days ago`;
}
