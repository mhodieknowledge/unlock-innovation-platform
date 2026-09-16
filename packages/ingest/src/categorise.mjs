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
 * A category code from what the listing calls itself, or null when it does not say.
 *
 * The title carries almost all of the signal, so it is weighted by being read alone first: a
 * page body mentioning "our scholarship programme" in a footer should not turn a hackathon
 * into a scholarship. Only when the title is silent does the summary get a look, and the page
 * body is never consulted — it is where the false positives live.
 *
 * @param {{ title?: string | null, summary?: string | null }} record
 * @returns {string | null}
 */
export function categoriseFromText(record) {
  const title = typeof record.title === "string" ? record.title : "";
  for (const [pattern, code] of SIGNALS) if (pattern.test(title)) return code;

  const summary = typeof record.summary === "string" ? record.summary : "";
  if (!summary) return null;
  for (const [pattern, code] of SIGNALS) if (pattern.test(summary)) return code;
  return null;
}
