/**
 * The category a listing announces about itself.
 *
 * WHY THIS IS NOT A MODEL'S JOB, at least not first. Thirty-five listings sat under "Other"
 * on the live site, and the category was written in the title of nearly every one of them:
 * "Gates Cambridge Scholarships", "AfricaLics Visiting PhD Fellowship", "NextStep Hacks",
 * "Inside Mastercard: Interns & Launchers ... Internship". A model was never needed to read
 * the word "Scholarship" in a title that says Scholarship; it was needed because nothing else
 * was looking.
 *
 * So this runs first, deterministically, and a model only sees what it leaves behind. That
 * ordering matters beyond cost: this function is auditable — a wrong answer is a regex
 * someone can read and a test someone can add — where a wrong answer from a model is a
 * shrug.
 *
 * IT READS THE TITLE AND NOTHING ELSE. See categoriseFromText: the summary fallback it used
 * to have produced every wrong answer in run 43 and no right ones.
 *
 * IT RETURNS NULL RATHER THAN GUESSING. "Women in Foreign Affairs Mentorship Group" and "The
 * Government of Japan Exchange and Teaching Programme" have no code in the taxonomy, and
 * inventing a near-miss for them would be worse than `other`: a reader filtering by
 * fellowship should not find a teaching exchange. Null means "I have nothing to say", which
 * is what leaves room for the model.
 */

/**
 * Ordered, most specific first, and the ORDER CARRIES MEANING.
 *
 * What a thing IS beats what it is ABOUT. "Pitch Perfect Africa 2026 Innovation Fellowship
 * for African Health Startups" mentions innovation, pitching and startups, and it is a
 * fellowship — so the award nouns are tested before the competition nouns. `hackathon` leads
 * because it is the least ambiguous word in the whole taxonomy.
 *
 * Every code here is checked against the live `categories` table by
 * packages/ingest/test/categorise.test.ts, so a taxonomy change cannot leave this pointing at
 * a code that no longer exists.
 *
 * @type {ReadonlyArray<readonly [RegExp, string]>}
 */
const SIGNALS = /** @type {const} */ ([
  [/\bhackathons?\b|\bhacks?\b(?!\s*(?:the|a)\b)|\bshipa(?:t|th)on\b|\bcodefest\b|\bgame\s?jam\b/i, "hackathon"],
  [/\bscholarships?\b|\bbursary\b|\bbursaries\b|\bstudentships?\b/i, "scholarship"],
  [/\bfellowships?\b|\bfellows?\s+programme?\b/i, "fellowship"],
  [/\binternships?\b|\binterns\b/i, "internship"],
  [/\bboot\s?camps?\b/i, "bootcamp"],
  [/\baccelerators?\b/i, "accelerator"],
  [/\bincubators?\b/i, "incubator"],
  [/\bcall\s+for\s+(?:papers|proposals|abstracts|submissions)\b|\bcfp\b/i, "conference_cfp"],
  [/\bgoogle\s+summer\s+of\s+code\b|\bgsoc\b|\boutreachy\b|\bopen\s+source\s+programme?\b/i, "open_source_program"],
  [/\bgrants?\b|\bfunding\s+(?:call|opportunit)/i, "grant"],
  [/\bpost\s?doc(?:toral)?\b|\bphd\s+position\b|\bresearch\s+(?:opportunit|programme?|position|fellowship)/i, "research_opportunity"],
  [/\bentrepreneurs?(?:hip)?\s+(?:programme?|investment\s+program)/i, "entrepreneurship_program"],
  [/\bdeveloper\s+programme?\b|\bdev\s+programme?\b/i, "developer_program"],
  [/\bdatathons?\b|\bdata\s+(?:science|analytics)\s+(?:challenge|competition|contest)\b/i, "data_competition"],
  [/\b(?:ai|artificial\s+intelligence|machine\s+learning|\bml)\b.{0,24}\b(?:challenge|competition|contest|prize)\b/i, "ai_challenge"],
  [/\b(?:coding|programming)\s+(?:competition|contest|challenge)\b/i, "coding_competition"],
  [/\bpitch\s+(?:competition|contest|event)\b/i, "pitch_competition"],
  [/\bstartup\s+(?:competition|challenge|contest|pitch)\b/i, "startup_competition"],
  [/\binnovation\b.{0,18}\b(?:challenge|competition|prize|award)\b/i, "innovation_challenge"],
  [/\bcommunity\s+challenge\b/i, "community_challenge"],
]);

/** Every code this module can produce, for the drift test. */
export const CATEGORISER_CODES = [...new Set(SIGNALS.map(([, code]) => code))];

/**
 * A category code from what the listing calls ITSELF, in its title, or null.
 *
 * THE TITLE IS THE ONLY FIELD READ, and that is a correction rather than a simplification.
 * An earlier version fell back to the summary when the title was silent. Run 43 put it over
 * the live `other` bucket: of 44 moves, every one taken from a title was right, and all four
 * wrong ones came from the summary.
 *
 *   grant        ← "UBA Foundation 2026 National Essay Competition"    (summary: awards grants to winners)
 *   scholarship  ← "2026 UBA National Essay Competition"               (summary: scholarship for the winner)
 *   scholarship  ← "Northeastern University Global Study Expo"         (summary: scholarships will be discussed)
 *   scholarship  ← "Cassava and Vodafone bring an AI data centre"      (summary: mentions a scholarship fund)
 *
 * A title names the thing. Any other prose MENTIONS things — what the prize is, what the
 * organiser also runs, what will be talked about at the event — and a mention reads exactly
 * like a declaration to a regex. Distinguishing them needs to know what the sentence is
 * DOING, which is a model's job and not a pattern's; `--recategorise` hands the leftovers to
 * one (prompts/classify.v1.md) rather than guessing here.
 *
 * `record` still takes a summary, and still ignores it. Dropping the field would make the
 * call sites look as though the summary had never been considered, and it was — wrongly, in
 * production, and that is worth leaving legible.
 *
 * @param {{ title?: string | null, summary?: string | null }} record
 * @returns {string | null}
 */
export function categoriseFromText(record) {
  const title = typeof record.title === "string" ? record.title : "";
  for (const [pattern, code] of SIGNALS) if (pattern.test(title)) return code;
  return null;
}

/**
 * Should a model's category be accepted? AI_SYSTEM.md §5's arrangement, applied to §4.
 *
 * VERSION ONE OF classify.v1 ASKED FOR A CODE AND NOTHING ELSE. Its first run against the live
 * catalogue moved three records and two were wrong:
 *
 *   scholarship       ← The Government of Japan Exchange and Teaching Programme  (a teaching job)
 *   data_competition  ← R.O.A.D. Barbados Historic Handwriting Challenge  (a transcription project)
 *
 * The prompt said to answer `other` when nothing fits. Neither of those has a word in this
 * taxonomy, and the model reached for the nearest one anyway — which is the failure a permitted
 * `other` was supposed to prevent and does not.
 *
 * So the model does not state a category any more. It quotes the phrase in the page that names
 * the kind of thing, and this function checks two things about that quote:
 *
 *   1. it is IN the page — rules.v1 has always worked this way, where "output is
 *      verbatim-quote validated regardless of model";
 *   2. and the quote itself names the category the model chose, read by the same
 *      `categoriseFromText` that reads titles.
 *
 * The second is the strict one, and it is where the division of labour sits. Deciding WHICH
 * sentence on a page is the declaration rather than a mention is a judgement about language: a
 * model makes it well and a pattern cannot make it at all. Reading a declarative phrase is a
 * pattern's job, and a pattern does not embellish. So the model chooses the sentence and the
 * regex names the thing, and neither is asked to do the other's work.
 *
 * Note what is NOT consulted: the model's own confidence. A confident wrong answer and a
 * hesitant wrong answer are the same wrong answer, and the quote is checkable where the
 * confidence is not.
 *
 * @param {{ code?: unknown, evidence?: unknown, source?: string, quoteIsVerbatim: (quote: string, source: string) => boolean }} input
 * @returns {{ ok: true, code: string } | { ok: false, reason: string }}
 */
export function acceptModelCategory(input) {
  const code = typeof input.code === "string" ? input.code.trim() : "";
  const evidence = typeof input.evidence === "string" ? input.evidence.trim() : "";
  const source = typeof input.source === "string" ? input.source : "";

  if (!code) return { ok: false, reason: "no category offered" };
  // `other` is an answer, not a failure: it means the model looked and found nothing that fits.
  if (code === "other") return { ok: false, reason: "answered other" };
  if (!evidence) return { ok: false, reason: `answered ${code} with no quote` };

  // With no stored page there is nothing to check the quote against, so the check has nothing
  // to say — and a claim that cannot be checked is not accepted on trust. An API record with no
  // page text keeps `other` until a fetch gives it one.
  if (!source) return { ok: false, reason: "no page text to check the quote against" };
  if (!input.quoteIsVerbatim(evidence, source)) {
    return { ok: false, reason: `quote is not in the page: "${evidence.slice(0, 48)}"` };
  }

  const readBack = categoriseFromText({ title: evidence });
  if (readBack !== code) {
    return {
      ok: false,
      reason: `quote "${evidence.slice(0, 40)}" reads as ${readBack ?? "no category"}, not ${code}`,
    };
  }
  return { ok: true, code };
}
