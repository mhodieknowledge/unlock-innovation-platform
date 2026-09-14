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
 *
 * WHY .mjs: the batch tier's crawler reads CRAWLER_USER_AGENT from here and runs as
 * plain Node with no build step, so this file has to be importable by both Node and
 * the web app's bundler. §2.1 rule 3 requires the User-Agent to point at a page
 * explaining the crawler, which means the string in every outbound request and the
 * string rendered on /bot have to be the same string — two copies would drift, and
 * the drift would be a crawler identifying itself with a URL that 404s.
 */
export const BRAND = /** @type {const} */ ({
  /** Swahili *mbele* — "forward / ahead". Provisional. */
  name: process.env["BRAND_NAME"] ?? "Mbele",
  domain: process.env["BRAND_DOMAIN"] ?? "example.invalid",
  handle: process.env["BRAND_HANDLE"] ?? "mbele",
});

/**
 * Published contact addresses. PRIVACY_AND_COMPLIANCE.md §7 item 4 requires "a
 * named contact address for privacy requests, published and monitored", and
 * OPPORTUNITY_INGESTION.md §2.1 rule 8 requires a published takedown address with
 * a 48-hour SLA. Separate addresses so each can be routed and monitored on its own
 * — a single catch-all is how a 48-hour SLA quietly becomes a fortnight.
 */
export const CONTACT = /** @type {const} */ ({
  privacy: `privacy@${BRAND.domain}`,
  takedown: `takedown@${BRAND.domain}`,
  security: `security@${BRAND.domain}`,
  support: `hello@${BRAND.domain}`,
});

/** OPPORTUNITY_INGESTION.md §2.1 rule 3 — identify the crawler honestly. */
export const CRAWLER_USER_AGENT = `${BRAND.name}Bot/1.0 (+https://${BRAND.domain}/bot)`;

/**
 * MODERATION_AND_TRUST.md §2.1 rule 3 — shown on every opportunity page and in
 * the Telegram bot, permanently. Invariant 13's user-facing half.
 */
export const NO_FEE_STATEMENT =
  "We never ask you to pay to apply. If an opportunity asks for a fee, report it.";
