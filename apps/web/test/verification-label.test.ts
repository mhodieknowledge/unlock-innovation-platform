/**
 * The enum never reaches the reader.
 *
 * Eight rows on the live board read "Zindi Africa · auto". `opp_verification` is a Postgres
 * enum and the row printed it straight out, which is how a database column becomes copy.
 *
 * The drift this guards is the one that will actually happen: someone adds a value to the
 * enum in a migration and not to the label map, and the board starts printing the new word
 * raw — or, with the null fallback, silently drops the whole clause. So the list is read from
 * the migration rather than restated here.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { VERIFICATION_LABEL, VERIFICATION_LEVELS, verificationLabel } from "../src/lib/verification";

/** The enum as the database actually declares it. */
function levelsFromMigration(): string[] {
  const sql = readFileSync(
    new URL("../../../supabase/migrations/0005_opportunities.up.sql", import.meta.url).pathname,
    "utf8",
  );
  const match = /CREATE TYPE opp_verification AS ENUM \(([\s\S]*?)\);/.exec(sql);
  expect(match, "opp_verification is not declared where this test looks for it").toBeTruthy();
  return [...match![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

describe("verification labels", () => {
  it("cover every value the database can hold", () => {
    const declared = levelsFromMigration();
    expect(declared.length).toBeGreaterThan(4);
    expect([...VERIFICATION_LEVELS].sort()).toEqual([...declared].sort());
    for (const level of declared) {
      expect(VERIFICATION_LABEL[level as never], `no label for "${level}"`).toBeTruthy();
    }
  });

  it("read as language rather than as a token", () => {
    // An underscore is the giveaway: `community_flagged` is a column value, not a sentence.
    // "Disputed" is left alone deliberately — it matches its enum value because it is also
    // the right English word, and a rule that banned it would be a rule about spelling
    // rather than about whether a reader understands.
    for (const level of VERIFICATION_LEVELS) {
      expect(VERIFICATION_LABEL[level], level).not.toContain("_");
      expect(VERIFICATION_LABEL[level][0], level).toBe(VERIFICATION_LABEL[level][0]!.toUpperCase());
    }
    expect(VERIFICATION_LABEL.auto).not.toBe("auto");
    expect(VERIFICATION_LABEL.community_flagged).not.toBe("community_flagged");
  });

  it("do not call an automated check verified", () => {
    // /verification tells readers an automated check "is shown as pending, never as verified".
    expect(VERIFICATION_LABEL.auto.toLowerCase()).not.toContain("verified");
    expect(VERIFICATION_LABEL.auto).toBe("Checked automatically");
  });

  it("do not imply a person is already looking at a disputed listing", () => {
    // MODERATION_AND_TRUST.md §2.2 sets `disputed` the moment a report arrives, before review.
    expect(VERIFICATION_LABEL.disputed.toLowerCase()).not.toContain("review");
  });

  it("answer null for a value this module has not been taught", () => {
    // Rather than falling back to the raw value, which is how the enum reached the page.
    expect(verificationLabel("something_new")).toBeNull();
    expect(verificationLabel(null)).toBeNull();
    expect(verificationLabel("official")).toBe("Official source");
  });
});
