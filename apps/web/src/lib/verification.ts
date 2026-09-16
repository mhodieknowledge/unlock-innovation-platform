/**
 * What a listing's verification level is called, in words a reader has a chance with.
 *
 * `opp_verification` is a Postgres enum — `official`, `verified`, `auto`, `community_flagged`,
 * `stale`, `expired`, `disputed` — and the board rendered it raw. Eight rows on the live site
 * read "Zindi Africa · auto", which tells a reader nothing and, worse, looks like a shrug.
 *
 * The labels are deliberately NOT reassuring where the state is not reassuring.
 * `/verification` promises that an automated check "is shown as pending, never as verified",
 * so `auto` says checked automatically and never borrows the word verified. MODERATION_AND_TRUST
 * §2.2 makes `disputed` a state we enter the moment a scam or payment report arrives, before any
 * human has looked — so it says disputed, not "under review", which would imply someone is
 * already looking.
 */

/** Every member of `opp_verification`, in the order the migration declares them. */
export const VERIFICATION_LEVELS = [
  "official",
  "verified",
  "auto",
  "community_flagged",
  "stale",
  "expired",
  "disputed",
] as const;

export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];

/**
 * Short, because this sits inside a dense row beside the organisation's name. The detail page
 * has room to explain; a row has room to be accurate.
 */
export const VERIFICATION_LABEL: Record<VerificationLevel, string> = {
  official: "Official source",
  verified: "Checked by a person",
  auto: "Checked automatically",
  community_flagged: "Flagged by a reader",
  stale: "Not confirmed recently",
  expired: "Closed",
  disputed: "Disputed",
};

/**
 * The label for a value that came out of the database.
 *
 * Falls back to null rather than to the raw value: a state this module has not been taught is
 * a state we cannot describe, and printing the enum is how this started.
 */
export function verificationLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return (VERIFICATION_LABEL as Record<string, string>)[value] ?? null;
}
