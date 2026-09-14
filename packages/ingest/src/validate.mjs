/**
 * Deterministic post-validation of model output.
 * AI_SYSTEM.md §2 guardrails, §4 and §5.
 *
 * "Output failing JSON-schema validation is discarded... Partially valid output is
 * never rendered." Everything in here runs AFTER the model and BEFORE the database,
 * and none of it trusts a single thing the model said about its own correctness.
 *
 * Reference data — valid country codes, currencies, rule types — is passed IN
 * rather than hard-coded, so the caller supplies our own tables (§5 rule 2: region
 * words expand "from our own regions table, never the model's country list").
 */

import { checkNoCopiedPhrase, quoteIsVerbatim } from "./text.mjs";

/** AI_SYSTEM.md §4: the confidence floors that gate auto-publication. */
export const CONFIDENCE_FLOOR = 0.75;
export const FIELD_CONFIDENCE_FLOOR = 0.8;

/** AI_SYSTEM.md §5 rule 4 and README.md invariant 3. */
export const HIGH_STAKES_RULE_TYPES = [
  "country_in",
  "country_not_in",
  "nationality_in",
  "age_between",
  "student_status_in",
];

/** ISO 4217, restricted to what actually appears in African opportunity listings. */
export const KNOWN_CURRENCIES = [
  "USD", "EUR", "GBP", "ZAR", "NGN", "KES", "GHS", "ZMW", "BWP", "NAD", "MWK",
  "MZN", "TZS", "UGX", "RWF", "ETB", "EGP", "MAD", "XOF", "XAF", "CDF", "AOA",
  "ZWG", "CAD", "AUD", "CHF", "JPY", "INR", "CNY", "SEK", "NOK", "DKK",
];

/**
 * A field's value plus what the model claimed about it. Kept as a pair through
 * validation so a field can be dropped without losing the record: AI_SYSTEM.md §4
 * wants a per-field confidence, and a record whose deadline is untrustworthy is
 * still worth publishing WITHOUT a deadline rather than not at all.
 *
 * @typedef {{ value: unknown, confidence: number }} Scored
 */

/**
 * @typedef {object} ValidationIssue
 * @property {string} field
 * @property {string} problem      what is wrong, in words an operator can act on
 * @property {"drop_field" | "review" | "discard"} effect
 */

/** @param {unknown} v */
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** @param {unknown} v @returns {number | null} */
export function asConfidence(v) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 1) return null;
  return n;
}

/**
 * ISO 3166-1 alpha-2, checked against the codes WE hold.
 *
 * Shape alone is not enough: "UK" and "EU" are both two uppercase letters and
 * neither is a country code, and a model asked for African countries will
 * occasionally produce "AF".
 *
 * @param {unknown} codes
 * @param {Set<string> | string[]} known
 * @returns {{ valid: string[], invalid: string[] }}
 */
export function validateCountryCodes(codes, known) {
  const knownSet = known instanceof Set ? known : new Set(known);
  /** @type {string[]} */
  const valid = [];
  /** @type {string[]} */
  const invalid = [];
  for (const raw of Array.isArray(codes) ? codes : []) {
    const code = String(raw ?? "").trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(code) && knownSet.has(code)) {
      if (!valid.includes(code)) valid.push(code);
    } else if (code !== "") {
      invalid.push(code);
    }
  }
  return { valid, invalid };
}

/** @param {unknown} code */
export function isKnownCurrency(code) {
  return KNOWN_CURRENCIES.includes(String(code ?? "").trim().toUpperCase());
}

/**
 * Validate one extracted opportunity record against §4's schema and its
 * deterministic post-validation.
 *
 * Returns a CLEANED record plus the issues found, rather than throwing: §4's
 * failure mode is "route to review", not "lose the document". An issue with
 * effect `discard` means the record cannot be stored at all; `review` means it can
 * be stored but never auto-published; `drop_field` means that one field was removed
 * and the rest stands.
 *
 * @param {unknown} candidate
 * @param {object} context
 * @param {string} context.sourceText the document the record came from
 * @param {Set<string> | string[]} context.knownCountries
 * @param {Date} [context.now]
 * @returns {{ record: Record<string, unknown>, issues: ValidationIssue[], confidence: Record<string, number> }}
 */
export function validateExtraction(candidate, context) {
  /** @type {ValidationIssue[]} */
  const issues = [];
  /** @type {Record<string, unknown>} */
  const record = {};
  /** @type {Record<string, number>} */
  const confidence = {};
  const now = context.now ?? new Date();

  if (!isPlainObject(candidate)) {
    return {
      record,
      issues: [
        { field: "(whole record)", problem: "the model did not return a JSON object", effect: "discard" },
      ],
      confidence,
    };
  }

  const raw = /** @type {Record<string, unknown>} */ (candidate);
  const scores = isPlainObject(raw["field_confidence"])
    ? /** @type {Record<string, unknown>} */ (raw["field_confidence"])
    : {};
  /** @param {string} field */
  const scoreOf = (field) => asConfidence(scores[field]) ?? 0;

  // ── title: without one there is nothing to publish ────────────────────────
  const title = typeof raw["title"] === "string" ? raw["title"].trim() : "";
  if (title.length < 3) {
    issues.push({ field: "title", problem: "no usable title was extracted", effect: "discard" });
  } else {
    record["title"] = title.slice(0, 200);
    confidence["title"] = scoreOf("title");
  }

  // ── summary: our own words, or nothing (§2.1 rule 6) ──────────────────────
  const summary = typeof raw["summary"] === "string" ? raw["summary"].trim() : "";
  if (summary) {
    if (summary.length > 400) {
      issues.push({
        field: "summary",
        problem: "summary exceeds the 400-character schema limit",
        effect: "drop_field",
      });
    } else {
      const copied = checkNoCopiedPhrase(summary, context.sourceText);
      if (!copied.ok) {
        // §4: "Failure -> regenerate once, then queue for human summary." The
        // regeneration is the caller's move; what is certain here is that this text
        // must not be stored.
        issues.push({
          field: "summary",
          problem: `summary copies the source: "${copied.phrase}"`,
          effect: "drop_field",
        });
      } else {
        record["summary"] = summary;
        confidence["summary"] = scoreOf("summary");
      }
    }
  }

  // ── deadline ──────────────────────────────────────────────────────────────
  const deadline = isPlainObject(raw["deadline"])
    ? /** @type {Record<string, unknown>} */ (raw["deadline"])
    : null;
  if (deadline) {
    const rawString = typeof deadline["raw_string"] === "string" ? deadline["raw_string"] : "";
    const parsed = parseDeadline(deadline["value"]);

    if (!parsed) {
      issues.push({
        field: "deadline",
        problem: "the deadline value is not a date we can parse",
        effect: "drop_field",
      });
    } else if (rawString && !quoteIsVerbatim(rawString, context.sourceText)) {
      // §4: "deadline.raw_string must appear verbatim in the source text." A
      // deadline whose supporting text is not in the document is the single most
      // expensive thing this system could get wrong.
      issues.push({
        field: "deadline",
        problem: `the quoted deadline text is not in the source: "${rawString.slice(0, 80)}"`,
        effect: "drop_field",
      });
    } else {
      let precision = String(deadline["precision"] ?? "unknown");
      if (!["exact_time", "date_only", "month_only", "rolling", "unknown"].includes(precision)) {
        precision = "unknown";
      }

      if (parsed.getTime() < now.getTime()) {
        // §4: "Dates in the past -> precision downgraded and flagged." A past
        // deadline is usually a relative date resolved against the wrong day, or
        // last year's page.
        issues.push({
          field: "deadline",
          problem: "the extracted deadline is already in the past",
          effect: "review",
        });
        precision = "unknown";
      }

      record["deadline_at"] = parsed.toISOString();
      record["deadline_precision"] = precision;
      if (rawString) record["deadline_raw"] = rawString.slice(0, 300);
      if (typeof deadline["timezone"] === "string") {
        record["deadline_timezone"] = deadline["timezone"].slice(0, 60);
      }
      confidence["deadline"] = scoreOf("deadline");
    }
  }

  // ── eligibility scope and countries ───────────────────────────────────────
  const scope = String(raw["eligibility_scope"] ?? "unclear");
  record["eligibility_scope"] = ["country_list", "region", "africa_wide", "global", "unclear"].includes(
    scope,
  )
    ? scope
    : "unclear";

  const { valid, invalid } = validateCountryCodes(raw["eligible_countries"], context.knownCountries);
  record["eligible_countries"] = valid;
  confidence["eligible_countries"] = scoreOf("eligible_countries");
  if (invalid.length > 0) {
    issues.push({
      field: "eligible_countries",
      problem: `not ISO 3166-1 alpha-2 codes we recognise: ${invalid.join(", ")}`,
      effect: "review",
    });
  }
  if (record["eligibility_scope"] === "country_list" && valid.length === 0) {
    issues.push({
      field: "eligible_countries",
      problem: "scope says a country list but no valid country was extracted",
      effect: "review",
    });
  }

  // ── cost: invariant 13's half of the schema ───────────────────────────────
  const cost = String(raw["cost"] ?? "unknown");
  record["cost"] = ["free", "paid", "unknown"].includes(cost) ? cost : "unknown";
  confidence["cost"] = scoreOf("cost");

  // ── prize ─────────────────────────────────────────────────────────────────
  const prize = isPlainObject(raw["prize"]) ? /** @type {Record<string, unknown>} */ (raw["prize"]) : null;
  if (prize && prize["amount"] !== null && prize["amount"] !== undefined) {
    const amount = Number(prize["amount"]);
    const currency = String(prize["currency"] ?? "").trim().toUpperCase();
    if (!Number.isFinite(amount) || amount < 0) {
      issues.push({ field: "prize", problem: "the prize amount is not a number", effect: "drop_field" });
    } else if (currency && !isKnownCurrency(currency)) {
      issues.push({
        field: "prize",
        problem: `"${currency}" is not an ISO 4217 code we recognise`,
        effect: "drop_field",
      });
    } else {
      record["prize_amount"] = amount;
      if (currency) record["prize_currency"] = currency;
      confidence["prize"] = scoreOf("prize");
    }
  }

  // ── mode, team, urls ──────────────────────────────────────────────────────
  const mode = String(raw["participation_mode"] ?? "unknown");
  record["participation_mode"] = ["online", "in_person", "hybrid", "unknown"].includes(mode)
    ? mode
    : "unknown";

  const team = isPlainObject(raw["team"]) ? /** @type {Record<string, unknown>} */ (raw["team"]) : null;
  if (team) {
    if (typeof team["required"] === "boolean") record["team_required"] = team["required"];
    const min = Number(team["min"]);
    const max = Number(team["max"]);
    if (Number.isInteger(min) && min > 0 && min < 1000) record["team_size_min"] = min;
    if (Number.isInteger(max) && max > 0 && max < 1000) record["team_size_max"] = max;
    if (
      typeof record["team_size_min"] === "number" &&
      typeof record["team_size_max"] === "number" &&
      record["team_size_min"] > record["team_size_max"]
    ) {
      delete record["team_size_min"];
      delete record["team_size_max"];
      issues.push({
        field: "team",
        problem: "the team size range is inverted",
        effect: "drop_field",
      });
    }
  }

  if (typeof raw["organisation_name"] === "string" && raw["organisation_name"].trim()) {
    record["organisation_name"] = raw["organisation_name"].trim().slice(0, 200);
    confidence["organisation_name"] = scoreOf("organisation_name");
  }

  const overall = asConfidence(raw["confidence"]);
  confidence["overall"] =
    overall ??
    // No self-reported overall confidence: take the weakest field rather than
    // averaging. An average lets a confident title carry an unreliable deadline.
    Math.min(1, ...[confidence["title"] ?? 0, confidence["deadline"] ?? 1, confidence["eligible_countries"] ?? 1]);

  return { record, issues, confidence };
}

/**
 * Parse a date the model returned. Deliberately narrow: ISO 8601 only.
 *
 * Free-form date parsing is where "03/04/2026" becomes 3 April or 4 March
 * depending on the runtime's locale, and a deadline wrong by a month is the worst
 * defect this product can ship. The model is instructed to return ISO; anything
 * else is a validation failure, not something to guess at.
 *
 * @param {unknown} value
 * @returns {Date | null}
 */
export function parseDeadline(value) {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(s)) {
    return null;
  }
  const date = new Date(s.length === 10 ? `${s}T00:00:00Z` : s.replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return null;
  // A date more than five years out is a parsing artefact, not a deadline.
  const year = date.getUTCFullYear();
  if (year < 2000 || year > new Date().getUTCFullYear() + 5) return null;
  return date;
}

/**
 * Validate derived eligibility rules. AI_SYSTEM.md §5's post-validation, `[PR]`.
 *
 * Rule 1 is the trust invariant: no verbatim quote, no rule. It is applied here and
 * nowhere else, so there is exactly one place where a rule can enter the system.
 *
 * @param {unknown} candidates
 * @param {object} context
 * @param {string} context.sourceText
 * @param {Set<string> | string[]} context.knownCountries
 * @param {string[]} context.knownRuleTypes
 * @param {(regionCodes: string[]) => string[]} [context.expandRegions] our own regions table
 * @returns {{ rules: Array<{rule_type: string, params: Record<string, unknown>, source_quote: string, confidence: number}>, rejected: Array<{rule: unknown, reason: string}> }}
 */
export function validateRules(candidates, context) {
  const rules = [];
  const rejected = [];
  const knownTypes = new Set(context.knownRuleTypes);

  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!isPlainObject(candidate)) {
      rejected.push({ rule: candidate, reason: "not an object" });
      continue;
    }
    const c = /** @type {Record<string, unknown>} */ (candidate);

    const ruleType = String(c["rule_type"] ?? "");
    if (!knownTypes.has(ruleType)) {
      rejected.push({ rule: candidate, reason: `unknown rule_type "${ruleType}"` });
      continue;
    }

    const quote = typeof c["source_quote"] === "string" ? c["source_quote"].trim() : "";
    if (!quote) {
      rejected.push({ rule: candidate, reason: "no source_quote" });
      continue;
    }
    if (!quoteIsVerbatim(quote, context.sourceText)) {
      // §2 guardrail 3 and §5 rule 1. This is the check the whole trust model rests
      // on, and it is why the model's confidence is irrelevant here.
      rejected.push({ rule: candidate, reason: "source_quote is not verbatim in the document" });
      continue;
    }

    const confidence = asConfidence(c["confidence"]);
    if (confidence === null) {
      rejected.push({ rule: candidate, reason: "confidence is missing or out of range" });
      continue;
    }

    /** @type {Record<string, unknown>} */
    const params = isPlainObject(c["params"])
      ? { .../** @type {Record<string, unknown>} */ (c["params"]) }
      : {};

    // §5 rule 2: country lists come from OUR regions table. A model's own list of
    // African countries is wrong often enough to matter, and the failure is silent.
    const regionParam = params["regions"];
    const countryParam = params["countries"];
    if (Array.isArray(regionParam) && context.expandRegions) {
      const expanded = context.expandRegions(regionParam.map(String));
      const existing = Array.isArray(countryParam) ? countryParam.map(String) : [];
      const merged = validateCountryCodes([...existing, ...expanded], context.knownCountries);
      params["countries"] = merged.valid;
      delete params["regions"];
    } else if (Array.isArray(countryParam)) {
      const checked = validateCountryCodes(countryParam, context.knownCountries);
      if (checked.valid.length === 0) {
        rejected.push({
          rule: candidate,
          reason: `no valid country codes in ${JSON.stringify(countryParam)}`,
        });
        continue;
      }
      params["countries"] = checked.valid;
    }

    rules.push({
      rule_type: ruleType,
      params,
      source_quote: quote.slice(0, 2000),
      confidence,
    });
  }

  return { rules, rejected };
}

/**
 * Does this record clear §4's confidence floors for auto-publication?
 *
 * The database makes the final routing decision (route_for_publication), which also
 * knows the source's trust and history. This is the extraction-side half, reported
 * separately so the two cannot be confused for each other.
 *
 * @param {Record<string, number>} confidence
 */
export function clearsConfidenceFloors(confidence) {
  return (
    (confidence["overall"] ?? 0) >= CONFIDENCE_FLOOR &&
    (confidence["deadline"] ?? 0) >= FIELD_CONFIDENCE_FLOOR &&
    (confidence["eligible_countries"] ?? 0) >= FIELD_CONFIDENCE_FLOOR
  );
}

/**
 * Fee and payment patterns. AI_SYSTEM.md §10: "Deterministic checks run first and
 * are never skipped `[PR]`". This is the one that protects invariant 13, and it runs
 * whether or not any model is available.
 *
 * Matched against the SOURCE text, not the model's `cost` field — the whole point is
 * to catch a fee the extraction missed or a page that buries it.
 */
const FEE_PATTERNS = [
  /\b(?:application|registration|processing|administrative|admin|entry|submission|participation)\s+fee\b/i,
  /\bfee\s+of\s+(?:usd|eur|gbp|ngn|kes|zar|ghs|r|\$|€|£)\s*\d/i,
  /\bnon[- ]refundable\s+(?:fee|deposit|payment)\b/i,
  /\bpay(?:ment)?\s+(?:of\s+)?(?:usd|eur|gbp|ngn|kes|zar|\$|€|£)\s*\d+\s+to\s+(?:apply|register|enter|participate)/i,
  /\b(?:send|transfer|wire)\s+(?:money|funds|payment)\b/i,
  /\bwestern\s+union\b/i,
  /\bmoneygram\b/i,
  /\b(?:bitcoin|btc|usdt|ethereum|crypto)\s+(?:wallet|address|payment)\b/i,
  /\b0x[a-fA-F0-9]{40}\b/,
  /\bapplicants?\s+(?:must|are\s+required\s+to)\s+pay\b/i,
];

/**
 * @param {string} text
 * @returns {{ hit: boolean, matches: string[] }}
 */
export function detectFeeLanguage(text) {
  const s = String(text ?? "");
  const matches = [];
  for (const pattern of FEE_PATTERNS) {
    const found = pattern.exec(s);
    if (found) matches.push(found[0].trim().slice(0, 120));
  }
  return { hit: matches.length > 0, matches };
}
