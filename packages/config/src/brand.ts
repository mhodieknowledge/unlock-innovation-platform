/**
 * PRODUCT_SPEC.md §1 — the name is a configuration token, not a hard-coded
 * string. README.md §6 item 1 lists trademark clearance, domain availability and
 * native-speaker connotation review across Swahili, Shona, Ndebele, Zulu, Yoruba,
 * Igbo, Hausa and Amharic as outstanding. Until those complete, the codename is
 * provisional and MUST stay confined to this module.
 *
 * Adjacent names known to be taken: Jenga (game trademark, and a Kenyan
 * fintech), Anzisha (the Anzisha Prize), Ubuntu (Canonical).
 * Documented alternates, in order: Njia, Jengo, Kesho, Sasa.
 */
export const BRAND = {
  /** Swahili *mbele* — "forward / ahead". Provisional. */
  name: process.env["BRAND_NAME"] ?? "Mbele",
  domain: process.env["BRAND_DOMAIN"] ?? "example.invalid",
  handle: process.env["BRAND_HANDLE"] ?? "mbele",
} as const;

/**
 * Published contact addresses. PRIVACY_AND_COMPLIANCE.md §7 item 4 requires "a
 * named contact address for privacy requests, published and monitored", and
 * OPPORTUNITY_INGESTION.md §2.1 rule 8 requires a published takedown address with
 * a 48-hour SLA. Separate addresses so each can be routed and monitored on its own
 * — a single catch-all is how a 48-hour SLA quietly becomes a fortnight.
 */
export const CONTACT = {
  privacy: `privacy@${BRAND.domain}`,
  takedown: `takedown@${BRAND.domain}`,
  security: `security@${BRAND.domain}`,
  support: `hello@${BRAND.domain}`,
} as const;

/** OPPORTUNITY_INGESTION.md §2.1 rule 3 — identify the crawler honestly. */
export const CRAWLER_USER_AGENT = `${BRAND.name}Bot/1.0 (+https://${BRAND.domain}/bot)`;

/**
 * MODERATION_AND_TRUST.md §2.1 rule 3 — shown on every opportunity page and in
 * the Telegram bot, permanently. Invariant 13's user-facing half.
 */
export const NO_FEE_STATEMENT =
  "We never ask you to pay to apply. If an opportunity asks for a fee, report it.";
