/**
 * Text normalisation and the copyright/paraphrase check.
 * OPPORTUNITY_INGESTION.md §4.3 and §2.1 rule 6, AI_SYSTEM.md §4.
 *
 * §2.1 rule 6 is the legal spine of the whole pipeline: "Store structured facts,
 * never article text... Summaries are written in our own words and validated
 * against an 8-word overlap check." That check is in here, and it is deterministic
 * — a model cannot be trusted to tell us whether it copied.
 */

/** §4.3: text_raw is truncated to 40 KB — the largest storage consumer. */
export const TEXT_RAW_LIMIT = 40 * 1024;

/** §2.1 rule 6 and AI_SYSTEM.md §4: an 8-consecutive-word overlap is a violation. */
export const OVERLAP_WORDS = 8;

const BLOCK_TAGS =
  "address|article|aside|blockquote|br|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul";

/**
 * HTML to readable text, main content only.
 *
 * §4.3 asks for "Readability-style main-content extraction, scripts/nav/footer
 * stripped". This is a deliberately small implementation rather than a dependency:
 * the batch tier runs on a free tier and every dependency is supply-chain surface
 * (SECURITY.md §8), and what the pipeline needs from Readability is the removal of
 * chrome, not a perfect reading view. Extraction quality is gated by confidence
 * scores and a human queue downstream, so a mediocre body-text guess degrades into
 * a review item rather than into a wrong published record.
 *
 * @param {string} html
 * @returns {{ text: string, title: string | null }}
 */
export function htmlToText(html) {
  if (typeof html !== "string") return { text: "", title: null };

  let working = html;

  // Order matters: comments first (they can contain unbalanced tags), then the
  // elements whose CONTENT must go, then the remaining tags.
  working = working.replace(/<!--[\s\S]*?-->/g, " ");

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(working);
  const title = titleMatch ? decodeEntities(titleMatch[1] ?? "").trim().slice(0, 500) : null;

  for (const tag of ["script", "style", "noscript", "template", "svg", "iframe", "form"]) {
    working = working.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
  }

  // Page chrome. Keeping it would put a site's navigation into every extraction,
  // and "Donate" and "Privacy policy" are not eligibility rules.
  for (const tag of ["nav", "header", "footer", "aside"]) {
    working = working.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
  }

  // Block boundaries become newlines BEFORE tags are stripped, so sentences from
  // adjacent list items do not run together into one sentence that never existed —
  // which would then fail the verbatim-quote check for a rule that is really there.
  working = working.replace(new RegExp(`<\\s*/?\\s*(?:${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n");
  working = working.replace(/<[^>]+>/g, " ");

  return { text: normaliseWhitespace(decodeEntities(working)), title };
}

/** @type {Record<string, string>} */
const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  pound: "£",
  euro: "€",
  deg: "°",
  eacute: "é",
};

/** @param {string} s */
export function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+[0-9]*);/gi, (whole, name) => {
      const key = String(name).toLowerCase();
      return NAMED_ENTITIES[key] ?? whole;
    });
}

/** @param {number} n */
function safeCodePoint(n) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return "";
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

/**
 * Collapse runs of whitespace, keeping paragraph breaks.
 *
 * Paragraph structure is kept because a deadline usually sits on its own line, and
 * flattening everything into one paragraph loses the only cue that "15 March" is a
 * heading rather than part of a sentence.
 *
 * @param {string} s
 */
export function normaliseWhitespace(s) {
  return String(s)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t   ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The form used for quote comparison: whitespace-normalised, case-folded, and with
 * the punctuation a copy-paste mangles reduced to one shape.
 *
 * AI_SYSTEM.md §2 guardrail 3 says the verbatim check is "verified by substring
 * match after whitespace normalisation". Typographic quotes and dashes are folded
 * as well, because a model that reproduces a sentence faithfully but turns a curly
 * apostrophe straight has not invented anything — and rejecting that rule would
 * lose a real eligibility constraint for a reason no user would accept.
 *
 * @param {string} s
 */
export function comparable(s) {
  return String(s ?? "")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/…/g, "...")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Is this quote genuinely present in the source?
 *
 * AI_SYSTEM.md §2 guardrail 3, `[PR]`: "Any extracted eligibility rule without a
 * verbatim source_quote present in the source text is rejected." This function is
 * the enforcement point for the product's trust invariant, so it is deliberately
 * strict in the one direction that matters: it never returns true for a sentence
 * the source does not contain.
 *
 * @param {string} quote
 * @param {string} sourceText
 * @returns {boolean}
 */
export function quoteIsVerbatim(quote, sourceText) {
  const q = comparable(quote);
  const source = comparable(sourceText);
  // A very short "quote" is not evidence of anything — "Africa" appears on every
  // page — and would let a rule through on a coincidence.
  if (q.length < 12) return false;
  return source.includes(q);
}

/** @param {string} s @returns {string[]} */
export function words(s) {
  return comparable(s)
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * The 8-word overlap check (§2.1 rule 6, AI_SYSTEM.md §4).
 *
 * Returns the offending phrase rather than a boolean, because the operator fixing a
 * rejected summary needs to know WHICH sentence was copied. Comparing n-gram sets
 * rather than scanning substrings keeps this linear in the source length; the
 * source can be 40 KB and this runs on every extraction.
 *
 * @param {string} summary the text we wrote
 * @param {string} sourceText the publisher's text
 * @param {number} [n]
 * @returns {{ ok: true } | { ok: false, phrase: string }}
 */
export function checkNoCopiedPhrase(summary, sourceText, n = OVERLAP_WORDS) {
  const summaryWords = words(summary);
  const sourceWords = words(sourceText);
  if (summaryWords.length < n || sourceWords.length < n) return { ok: true };

  const seen = new Set();
  for (let i = 0; i + n <= sourceWords.length; i += 1) {
    seen.add(sourceWords.slice(i, i + n).join(" "));
  }
  for (let i = 0; i + n <= summaryWords.length; i += 1) {
    const phrase = summaryWords.slice(i, i + n).join(" ");
    if (seen.has(phrase)) return { ok: false, phrase };
  }
  return { ok: true };
}

/**
 * sha256 of the normalised text. §4.3: an unchanged hash stops the pipeline and
 * only updates last_fetch_at.
 *
 * Hashing the NORMALISED text rather than the raw bytes is the point: a page whose
 * only change is a rotating advert or a "last updated" timestamp in a footer we
 * already strip is not a changed page, and re-extracting it would spend an LLM call
 * and risk a spurious change notification for every tracker.
 *
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function contentHash(text) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(normaliseWhitespace(String(text)), "utf8").digest("hex");
}

/**
 * §4.3: truncate to 40 KB, at a sentence or paragraph break so a stored quote is
 * not cut in half — a half-sentence would then fail the verbatim check for a rule
 * that really is in the document.
 *
 * @param {string} text
 * @param {number} [limit]
 */
export function truncateForStorage(text, limit = TEXT_RAW_LIMIT) {
  const s = normaliseWhitespace(text);
  if (Buffer.byteLength(s, "utf8") <= limit) return s;

  // Byte-accurate truncation, then back off to the last paragraph break so the
  // stored text ends somewhere a sentence ended.
  let cut = Buffer.from(s, "utf8").subarray(0, limit).toString("utf8");
  // A multi-byte character split by the slice becomes U+FFFD; drop it.
  cut = cut.replace(/�+$/, "");
  // +1 on a sentence break so the full stop survives; a stored fragment ending
  // mid-sentence would fail the verbatim check for a quote that is really there.
  const sentenceEnd = cut.lastIndexOf(". ");
  const paragraphEnd = cut.lastIndexOf("\n");
  const breakAt = sentenceEnd > paragraphEnd ? sentenceEnd + 1 : paragraphEnd;
  return (breakAt > limit * 0.8 ? cut.slice(0, breakAt) : cut).trim();
}
