/**
 * Pure ingestion logic. No I/O, no network, no database.
 *
 * Everything here is deterministic and unit-tested, because it is the half of the
 * pipeline that decides whether something untrue reaches a user: the verbatim-quote
 * check, the 8-word copy check, URL canonicalisation (the dedupe key for the whole
 * catalogue), and the validations that model output has to survive.
 *
 * Written as .mjs rather than .ts so the batch tier can run it directly with no
 * build step, while still being typechecked — see the note in tsconfig.json.
 */

export { acceptModelCategory, CATEGORISER_CODES, categoriseFromText } from "./categorise.mjs";
export { ARTICLE_REASONS, articleShape } from "./relevance.mjs";

export { canonicaliseUrl, hostOf, sameHost } from "./urls.mjs";

export {
  OVERLAP_WORDS,
  TEXT_RAW_LIMIT,
  checkNoCopiedPhrase,
  comparable,
  contentHash,
  decodeEntities,
  htmlToText,
  normaliseWhitespace,
  quoteIsVerbatim,
  truncateForStorage,
  words,
} from "./text.mjs";

export {
  CONFIDENCE_FLOOR,
  FIELD_CONFIDENCE_FLOOR,
  HIGH_STAKES_RULE_TYPES,
  KNOWN_CURRENCIES,
  asConfidence,
  clearsConfidenceFloors,
  detectFeeLanguage,
  isKnownCurrency,
  parseDeadline,
  validateCountryCodes,
  validateExtraction,
  validateRules,
} from "./validate.mjs";

export { extractJsonLd, findOpportunityNode, recordFromJsonLd } from "./jsonld.mjs";

export { THIN_TEXT_CHARS, detectChallenge, looksUnrendered, stillChallenged } from "./challenge.mjs";

export { API_ADAPTERS, devpostHackathons, itemsFromApi, parseDateRange } from "./apis.mjs";

export { BREAKER_MS, Breakers, MAX_INPUT_CHARS, callProvider, parseJsonLoose, runTask } from "./providers.mjs";
export { delayFor, isAllowed, parseRobots } from "./robots.mjs";
export { itemsSince, parseFeed, parseSitemap } from "./feeds.mjs";
