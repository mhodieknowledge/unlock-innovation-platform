/**
 * robots.txt. OPPORTUNITY_INGESTION.md §2.1 rule 1: "Honour robots.txt for every
 * fetch. Record the check in sources.robots_checked_at."
 *
 * Non-negotiable is the word the spec uses, so this is written to fail CLOSED: a
 * robots.txt we cannot parse, cannot fetch, or cannot understand means we do not
 * fetch the page. That is the opposite of the usual crawler convention (most treat
 * an unreachable robots.txt as permission), and it is deliberate — §2 rates the
 * legal posture above coverage, and the whole source tier above this one exists
 * precisely so that losing a page costs us little.
 *
 * Implements the parts of RFC 9309 that decide access: User-agent grouping,
 * Allow/Disallow with wildcards, longest-match precedence, and Crawl-delay.
 */

/**
 * @typedef {object} RobotsRules
 * @property {Array<{ allow: boolean, pattern: string }>} rules  in file order
 * @property {number | null} crawlDelaySeconds
 * @property {string[]} sitemaps
 * @property {boolean} explicit  true when a group actually matched our agent
 */

/**
 * @param {string} text
 * @param {string} userAgent our token, e.g. "MbeleBot"
 * @returns {RobotsRules}
 */
export function parseRobots(text, userAgent) {
  /** @type {RobotsRules} */
  const result = { rules: [], crawlDelaySeconds: null, sitemaps: [], explicit: false };
  if (typeof text !== "string") return result;

  const token = String(userAgent ?? "").toLowerCase();

  /** Groups are keyed by the set of agents they name (RFC 9309 §2.2.1). */
  let currentAgents = [];
  let lastLineWasAgent = false;
  /** @type {Map<string, Array<{allow: boolean, pattern: string}>>} */
  const groups = new Map();
  /** @type {Map<string, number>} */
  const delays = new Map();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;

    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "sitemap") {
      // Sitemap is global, not part of any group.
      if (value) result.sitemaps.push(value);
      continue;
    }

    if (field === "user-agent") {
      // Consecutive User-agent lines form ONE group. A group's rules apply to
      // every agent named in it, and treating each line as a new group is the
      // classic parsing bug that makes a crawler ignore a directive meant for it.
      if (!lastLineWasAgent) currentAgents = [];
      const agent = value.toLowerCase();
      currentAgents.push(agent);
      // Register the group even before it has any Allow/Disallow line. A group
      // carrying only Crawl-delay is legal and common, and keying group existence
      // on rule lines would silently discard the delay it asked for.
      if (!groups.has(agent)) groups.set(agent, []);
      lastLineWasAgent = true;
      continue;
    }

    lastLineWasAgent = false;
    if (currentAgents.length === 0) continue;

    for (const agent of currentAgents) {
      if (field === "allow" || field === "disallow") {
        const list = groups.get(agent) ?? [];
        // An empty Disallow means "allow everything" (RFC 9309 §2.2.2).
        list.push({ allow: field === "allow" || value === "", pattern: value });
        groups.set(agent, list);
      } else if (field === "crawl-delay") {
        const seconds = Number(value);
        if (Number.isFinite(seconds) && seconds >= 0) delays.set(agent, seconds);
      }
    }
  }

  // Most specific agent match wins: our exact token, then any agent string that is
  // a prefix of ours, then "*".
  let chosen = null;
  if (groups.has(token)) chosen = token;
  if (chosen === null) {
    for (const agent of groups.keys()) {
      if (agent !== "*" && token.startsWith(agent)) {
        chosen = agent;
        break;
      }
    }
  }
  if (chosen === null && groups.has("*")) chosen = "*";

  if (chosen !== null) {
    result.rules = groups.get(chosen) ?? [];
    result.explicit = true;
    const delay = delays.get(chosen) ?? delays.get("*");
    if (delay !== undefined) result.crawlDelaySeconds = delay;
  }

  return result;
}

/**
 * Does a rule pattern match this path? Supports `*` and `$` (RFC 9309 §2.2.3).
 *
 * @param {string} pattern
 * @param {string} path
 */
function patternMatches(pattern, path) {
  if (pattern === "") return true;
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const rx = new RegExp(`^${escaped}${anchored ? "$" : ""}`);
  return rx.test(path);
}

/**
 * May we fetch this path?
 *
 * Longest matching pattern wins; Allow beats Disallow on an equal-length tie, which
 * is what lets a site disallow a directory and allow one page inside it.
 *
 * @param {RobotsRules} robots
 * @param {string} url
 * @returns {boolean}
 */
export function isAllowed(robots, url) {
  let path;
  try {
    const parsed = new URL(url);
    path = `${parsed.pathname}${parsed.search}`;
  } catch {
    return false;
  }

  let best = null;
  for (const rule of robots.rules) {
    if (!patternMatches(rule.pattern, path)) continue;
    const length = rule.pattern.replace(/\$$/, "").length;
    if (
      best === null ||
      length > best.length ||
      // Equal length: Allow wins.
      (length === best.length && rule.allow && !best.allow)
    ) {
      best = { length, allow: rule.allow };
    }
  }

  // No rule matched: allowed by the standard, and by us — a robots.txt that says
  // nothing about a path is not a refusal. The fail-closed rule applies to a
  // robots.txt we could not READ, which is the fetcher's decision, not this one's.
  return best === null ? true : best.allow;
}

/**
 * The delay to use between requests to one host.
 *
 * §2.1 rule 4 sets our own floor at one request every ten seconds. A site asking for
 * MORE than that gets what it asks for; a site asking for less still gets ten
 * seconds, because the floor is our promise rather than theirs.
 *
 * @param {RobotsRules} robots
 * @param {number} [floorSeconds]
 */
export function delayFor(robots, floorSeconds = 10) {
  const requested = robots.crawlDelaySeconds;
  if (requested === null || !Number.isFinite(requested)) return floorSeconds * 1000;
  return Math.max(floorSeconds, requested) * 1000;
}
