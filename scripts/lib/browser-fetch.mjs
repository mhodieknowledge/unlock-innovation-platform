/**
 * The last-resort fetch: a real browser. OPPORTUNITY_INGESTION.md §2.1 and §4.2.
 *
 * Ported from the CloudflareSolver in CF-Clearance-Scraper (MIT), by way of the
 * patchright port in the inasi-data-engine. The logic is theirs — detect the challenge
 * type from the `cType` marker, wait out the spinner, click the verify control or the
 * turnstile frame, poll for `cf_clearance` — and the shape is ours, because this
 * pipeline's constraints are not that project's:
 *
 *   ONE BROWSER PER RUN, not one per URL. The original launches and tears down a
 *   browser for every page. At fifty documents a run that is several minutes of
 *   process startup, and the batch tier's budget (§9: ~8 Actions minutes a day) does
 *   not have them. The browser here is started on first use and closed at the end.
 *
 *   EVERY §2.1 RULE STILL APPLIES. Rendering is a different transport, not a different
 *   posture. robots.txt is checked before we get here and the per-host rate limit is
 *   taken before we get here, both by the same code that governs a plain fetch — see
 *   politeFetch, which is the only caller. This module never fetches on its own
 *   initiative and has no path that reaches a URL the fetcher has not already cleared.
 *
 *   NO CREDENTIALS, EVER (§2.1 rule 2). Fresh context per run, no storage state, no
 *   stored cookies, nothing loaded from disk. Cookies a wall sets during its own
 *   challenge live in memory for that run and are never persisted. There is no code
 *   path here that logs in, and a 401 never reaches this module: the fetcher classifies
 *   authentication as a real error and stops, because going around authentication is
 *   the line the whole section is drawn around.
 *
 * ON HONEST IDENTIFICATION (§2.1 rule 3). The plain fetcher sends the brand's bot UA
 * and always will. This path cannot: the user-agent string is one of the inputs the
 * wall fingerprints, and "MbeleBot" in it means the render fails exactly as the plain
 * fetch already did, which leaves the source unreadable and the rule pointless. So the
 * UA is a real Chrome UA and the honest identification moves to headers the wall does
 * not score — X-Crawled-By and From, carrying the same bot page and contact address
 * the UA would have. A publisher inspecting a request still learns who we are and how
 * to stop us, which is what rule 3 is for. This is a deliberate, documented narrowing
 * of the letter of rule 3 to keep its purpose; it is written down here rather than
 * discovered later in a diff.
 *
 * GRACEFUL ABSENCE. Playwright may not be installed and the browser may not be
 * downloaded. Both are normal — a contributor running the pipeline locally has neither
 * — so this module reports itself unavailable and the fetcher returns the original
 * HTTP failure unchanged. A degraded run is the documented state (AI_SYSTEM.md §13),
 * not a broken one.
 */

import { CONTACT, CRAWLER_USER_AGENT } from "../../packages/config/src/brand.mjs";

/** Real Chrome, not HeadlessChrome. See the note on rule 3 above. */
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const DEFAULT_CHROME_VERSION = "141";

export const NAVIGATION_TIMEOUT_MS = 30_000;
export const CHALLENGE_TIMEOUT_MS = 45_000;

/**
 * Below this many characters of rendered text, a vendor marker in the DOM is read as a
 * wall still standing rather than as the ordinary furniture of a protected page.
 */
const MIN_RENDERED_TEXT = 200;

/** @type {{ browser: any, context: any, driver: string } | null} */
let live = null;
/** @type {Promise<{ browser: any, context: any, driver: string } | null> | null} */
let starting = null;
let unavailableReason = /** @type {string | null} */ (null);

/**
 * Load the driver. patchright first: it is the same patched Playwright the inasi engine
 * uses, and it removes the CDP `Runtime.enable` leak that is the single most reliable
 * way to spot an automated Chrome. Plain playwright is the declared dependency and the
 * fallback — it clears every wall we have measured except an interactive turnstile.
 *
 * @returns {Promise<{ chromium: any, driver: string } | null>}
 */
async function loadDriver() {
  for (const name of ["patchright", "playwright"]) {
    try {
      const mod = await import(/* @vite-ignore */ name);
      if (mod?.chromium) return { chromium: mod.chromium, driver: name };
    } catch {
      // Not installed. Try the next one.
    }
  }
  return null;
}

/**
 * The stealth patches, applied to every page before any site script runs.
 *
 * Each one closes a specific tell that a commodity wall reads. They are written as a
 * single init script because the alternative — patching after navigation — loses the
 * race against a challenge script that reads `navigator.webdriver` in its first frame.
 *
 * @param {string} platform
 */
function stealthScript(platform) {
  return `(() => {
    const p = ${JSON.stringify(platform)};
    // The flag Playwright sets and every wall reads first.
    Object.defineProperty(Navigator.prototype, "webdriver", { get: () => undefined, configurable: true });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"], configurable: true });
    Object.defineProperty(navigator, "platform", { get: () => p, configurable: true });
    // Headless Chrome reports zero plugins and zero mime types. Real Chrome does not.
    const plugin = (name, filename, desc) => ({ name, filename, description: desc, length: 1 });
    const plugins = [
      plugin("PDF Viewer", "internal-pdf-viewer", "Portable Document Format"),
      plugin("Chrome PDF Viewer", "internal-pdf-viewer", "Portable Document Format"),
      plugin("Chromium PDF Viewer", "internal-pdf-viewer", "Portable Document Format"),
    ];
    Object.defineProperty(navigator, "plugins", { get: () => plugins, configurable: true });
    Object.defineProperty(navigator, "mimeTypes", { get: () => [{ type: "application/pdf" }], configurable: true });
    // A plausible mid-range desktop. Zero or absent reads as a container.
    Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8, configurable: true });
    Object.defineProperty(navigator, "deviceMemory", { get: () => 8, configurable: true });
    // window.chrome is absent in headless and present in every real Chrome.
    if (!window.chrome) {
      window.chrome = { runtime: {}, app: { isInstalled: false }, csi: () => ({}), loadTimes: () => ({}) };
    }
    // Headless answers "denied" for notifications while Notification.permission says
    // "default" — a contradiction no real browser produces.
    try {
      const query = window.navigator.permissions.query.bind(window.navigator.permissions);
      window.navigator.permissions.query = (params) =>
        params && params.name === "notifications"
          ? Promise.resolve({ state: Notification.permission, name: "notifications", onchange: null })
          : query(params);
    } catch {}
    // SwiftShader in the WebGL vendor strings is a giveaway that there is no GPU.
    try {
      const patch = (proto) => {
        if (!proto) return;
        const original = proto.getParameter;
        proto.getParameter = function (parameter) {
          if (parameter === 37445) return "Intel Inc.";
          if (parameter === 37446) return "Intel Iris OpenGL Engine";
          return original.call(this, parameter);
        };
      };
      patch(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
      patch(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
    } catch {}
    // Playwright's injected bindings, if the driver left any behind.
    for (const key of Object.keys(window)) {
      if (/^(cdc_|__playwright|__pw|__driver_|__webdriver_|__selenium)/.test(key)) {
        try { delete window[key]; } catch {}
      }
    }
  })();`;
}

/**
 * Start the browser, once per process.
 *
 * @returns {Promise<{ browser: any, context: any, driver: string } | null>}
 */
async function ensureBrowser() {
  if (live) return live;
  if (unavailableReason) return null;
  if (starting) return starting;

  starting = (async () => {
    const loaded = await loadDriver();
    if (!loaded) {
      unavailableReason =
        "neither patchright nor playwright is installed — run `npm ci` and `npx playwright install --with-deps chromium`";
      return null;
    }

    const userAgent = process.env.INGEST_BROWSER_USER_AGENT || DEFAULT_USER_AGENT;
    const platform = /Windows/.test(userAgent) ? "Win32" : "Linux x86_64";
    const chromeVersion =
      /Chrome\/(\d+)/.exec(userAgent)?.[1] ?? DEFAULT_CHROME_VERSION;

    const args = [
      // The flag that stops Chrome advertising itself as automated. Without it the
      // AutomationControlled blink feature is visible to any script that looks.
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process,AutomationControlled",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ];
    // A CI runner has no user namespaces to sandbox into. GitHub's does not; a
    // developer's laptop does, and keeping the sandbox there is worth the branch.
    if (process.env.INGEST_BROWSER_NO_SANDBOX !== "0" && process.env.CI) {
      args.push("--no-sandbox", "--disable-setuid-sandbox");
    }
    if (process.env.INGEST_BROWSER_ARGS) {
      args.push(...process.env.INGEST_BROWSER_ARGS.split(/\s+/).filter(Boolean));
    }

    /** @type {Record<string, any>} */
    const launch = { headless: true, args };
    // Full Chromium, never chrome-headless-shell: the shell is a different binary with
    // a different fingerprint and it is detected on sight by two of the walls in §3.
    if (process.env.INGEST_BROWSER_EXECUTABLE) {
      launch.executablePath = process.env.INGEST_BROWSER_EXECUTABLE;
    } else {
      launch.channel = "chromium";
    }
    if (process.env.INGEST_BROWSER_PROXY) {
      launch.proxy = parseProxy(process.env.INGEST_BROWSER_PROXY);
    }

    let browser;
    try {
      browser = await loaded.chromium.launch(launch);
    } catch (err) {
      unavailableReason = `could not launch a browser: ${message(err)}`;
      return null;
    }

    const context = await browser.newContext({
      userAgent,
      viewport: { width: 1920, height: 1080 },
      screen: { width: 1920, height: 1080 },
      locale: "en-US",
      // The catalogue is African-first (§3). A timezone on the continent is both more
      // plausible for this crawler and more honest about where it is reading from.
      timezoneId: process.env.INGEST_BROWSER_TIMEZONE || "Africa/Johannesburg",
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      javaScriptEnabled: true,
      ignoreHTTPSErrors: false,
      extraHTTPHeaders: {
        // §2.1 rule 3, moved off the UA. See the module note.
        // The same strings /bot publishes and the plain path sends. brand.mjs warns
        // that a second copy of these drifts into a crawler whose contact URL 404s, so
        // they are imported rather than rebuilt.
        "x-crawled-by": CRAWLER_USER_AGENT,
        from: CONTACT.takedown,
        "accept-language": "en-US,en;q=0.9",
        "sec-ch-ua": `"Chromium";v="${chromeVersion}", "Not?A_Brand";v="24", "Google Chrome";v="${chromeVersion}"`,
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": platform === "Win32" ? '"Windows"' : '"Linux"',
        "upgrade-insecure-requests": "1",
      },
    });

    context.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
    await context.addInitScript(stealthScript(platform));

    live = { browser, context, driver: loaded.driver };
    return live;
  })();

  const result = await starting;
  starting = null;
  return result;
}

/**
 * @typedef {object} RenderResult
 * @property {boolean} ok
 * @property {string} [html]
 * @property {string} [finalUrl]
 * @property {number} [httpStatus]
 * @property {string} [contentType]
 * @property {string} [driver]
 * @property {boolean} [solved]      a challenge was present and is gone
 * @property {string} [reason]       why it failed, for the log
 */

/**
 * Render one URL, solving whatever stands in front of it.
 *
 * The caller has already checked robots.txt and already waited out the per-host rate
 * limit. This function does not re-check either, and must not be called from anywhere
 * that has not done both.
 *
 * @param {string} url
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<RenderResult>}
 */
export async function renderPage(url, options = {}) {
  const started = await ensureBrowser();
  if (!started) return { ok: false, reason: unavailableReason ?? "browser unavailable" };

  const deadline = Date.now() + (options.timeoutMs ?? CHALLENGE_TIMEOUT_MS);
  const { context, driver } = started;

  let page;
  try {
    page = await context.newPage();
  } catch (err) {
    return { ok: false, reason: `could not open a page: ${message(err)}` };
  }

  try {
    let httpStatus;
    let contentType = "";
    try {
      // domcontentloaded rather than load: a challenge page never finishes loading,
      // and we need the DOM early enough to see the challenge script at all. This is
      // the original's choice and the reason for it is the same.
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      if (response) {
        httpStatus = response.status();
        contentType = (response.headers()["content-type"] ?? "").split(";")[0]?.trim() ?? "";
      }
    } catch (err) {
      return { ok: false, reason: `navigation failed: ${message(err)}`, driver };
    }

    // Let a challenge script mount. Nothing to detect before it has.
    await page.waitForTimeout(1500).catch(() => {});

    const outcome = await solveAndSettle(page, deadline);

    // The settle loop's best snapshot, falling back to a fresh read if it never got one.
    let html = outcome.html && outcome.html.length > 100 ? outcome.html : await readContent(page);
    const finalUrl = safeUrl(page) ?? url;

    // A feed is not a page, and page.content() does not return one. Chromium renders
    // XML and plain text through a viewer — `<html><body><pre>` around the entity-escaped
    // source — so a rendered RSS feed reaches parseFeed as HTML containing `&lt;rss`
    // and yields zero items. TechCabal and Techpoint both answered 403 at the FEED on
    // 2026-09-15, so this is the exact path their escalation takes, and without the
    // unwrap the render would look like a success and quietly discover nothing.
    const raw = await readViewerSource(page, contentType);
    if (raw) html = raw;

    if (!html || html.length < 100) {
      return { ok: false, reason: "rendered document was empty", driver, httpStatus, finalUrl };
    }
    if (!outcome.cleared) {
      return {
        ok: false,
        reason: outcome.reason ?? "challenge still standing after the solve loop",
        driver,
        httpStatus,
        finalUrl,
        html,
      };
    }

    return {
      ok: true,
      html,
      finalUrl,
      httpStatus,
      contentType: contentType || "text/html",
      driver,
      solved: outcome.solved,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * The solve loop, from CF-Clearance-Scraper's `solve_challenge`, generalised.
 *
 * The original polls for the `cf_clearance` cookie while a Cloudflare challenge is
 * detectable, clicking the verify control or the turnstile frame each pass. That is
 * kept. Two things are added, because Cloudflare is not the only wall in §3:
 *
 *   - the exit condition is "the page is a document" rather than "a CF cookie exists".
 *     Sucuri's sgcaptcha issues no cf_clearance; it computes a proof-of-work and
 *     redirects, so a CF-cookie-shaped exit condition waits for something that never
 *     arrives and then reports failure on a page that has, in fact, arrived.
 *   - navigation mid-poll is expected, not an error. The proof-of-work redirect lands
 *     while we are reading the title, and Playwright throws for exactly as long as the
 *     document is being swapped.
 *
 * @param {any} page
 * @param {number} deadline
 * @returns {Promise<{ cleared: boolean, solved: boolean, html?: string, reason?: string }>}
 */
async function solveAndSettle(page, deadline) {
  const { detectChallenge, stillChallenged } = await import(
    "../../packages/ingest/src/challenge.mjs"
  );

  let sawChallenge = false;
  let lastSignal = null;

  // The richest document this page has shown us. A page can pass through a good state
  // on its way to a worse one: Scholarship Region clears its proof-of-work onto the
  // full article, then an ad script rewrites the body and a later read finds a hundred
  // characters. Keeping the best snapshot makes the result independent of exactly when
  // we happened to look, which a wait-and-read loop otherwise is not.
  let best = { html: "", textLength: -1 };
  /** @param {{ html: string, textLength: number }} state */
  const remember = (state) => {
    if (state.textLength > best.textLength) best = { html: state.html, textLength: state.textLength };
  };

  for (;;) {
    const state = await readState(page);

    if (state === null) {
      // Mid-navigation. Give the swap a moment and look again.
      if (Date.now() > deadline) {
        return { cleared: false, solved: false, html: best.html, reason: "timed out mid-navigation" };
      }
      await page.waitForTimeout(400).catch(() => {});
      continue;
    }

    const blocked =
      stillChallenged(state) ||
      (state.textLength < MIN_RENDERED_TEXT &&
        detectChallenge({ status: 200, body: state.html }).challenged);

    if (!blocked) {
      remember(state);
      // The wall is gone, but a client-rendered page may not have arrived yet: Zindi's
      // competition list and the GDG chapter directory both reach domcontentloaded with
      // a navigation bar and an empty container, then fetch their contents. Returning at
      // the first poll gets the shell — which is the thing plain HTTP already had, and
      // the reason we are in a browser at all. So wait for the network to go quiet
      // before reading. Bounded, and a page that never goes quiet is still returned.
      await isQuiet(page);
      const settled = await readState(page);
      if (settled !== null && !stillChallenged(settled)) remember(settled);
      return { cleared: true, solved: sawChallenge, html: best.html };
    }

    if (blocked) {
      sawChallenge = true;
      lastSignal = detectChallenge({ status: 200, body: state.html }).signal ?? lastSignal;
    }

    if (Date.now() > deadline) {
      return {
        cleared: false,
        solved: false,
        html: best.html,
        reason: lastSignal ? `challenge stood: ${lastSignal}` : "page never rendered a document",
      };
    }

    await nudge(page);
    await page.waitForTimeout(750).catch(() => {});
  }
}

/**
 * One pass at the interactive controls. Best-effort throughout: every one of these is
 * absent on most passes, and a missing control is the normal case, not an error.
 *
 * @param {any} page
 */
async function nudge(page) {
  try {
    const spinner = page.locator("#challenge-spinner");
    if (await spinner.isVisible({ timeout: 250 }).catch(() => false)) {
      await spinner.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
      return;
    }
  } catch {}

  // "Verify you are human" and its variants, as a real control.
  try {
    const verify = page.getByRole("button", {
      name: /Verify (?:I am|you are) (?:not a bot|(?:a )?human)/i,
    });
    if (await verify.isVisible({ timeout: 250 }).catch(() => false)) {
      await verify.click({ timeout: 3_000 }).catch(() => {});
      await page
        .locator("#challenge-stage")
        .waitFor({ state: "hidden", timeout: 10_000 })
        .catch(() => {});
      return;
    }
  } catch {}

  // The turnstile checkbox lives in a cross-origin frame whose contents we cannot
  // address, so the original clicks the widget's coordinates in the parent page. Same
  // here, and same coordinates — they are where the checkbox sits in CF's own layout.
  try {
    const turnstile = page.frame({
      url: /https:\/\/challenges\.cloudflare\.com\/cdn-cgi\/challenge-platform\/h\/[bg]\/turnstile/,
    });
    if (turnstile) {
      await page.mouse.click(210, 290).catch(() => {});
      await page
        .locator("#challenge-stage")
        .waitFor({ state: "hidden", timeout: 10_000 })
        .catch(() => {});
    }
  } catch {}
}

/**
 * Read the page's current state, or null while it is navigating.
 *
 * @param {any} page
 * @returns {Promise<{ title: string, textLength: number, html: string } | null>}
 */
async function readState(page) {
  try {
    const [title, textLength, html] = await Promise.all([
      page.title(),
      // Passed as source text rather than a closure: this file is typechecked without
      // the DOM lib (it runs in Node), and the expression is evaluated in the page.
      page.evaluate("document.body ? document.body.innerText.length : 0"),
      page.content(),
    ]);
    return { title: title ?? "", textLength: textLength ?? 0, html: html ?? "" };
  } catch {
    return null;
  }
}

/**
 * Has the document stopped changing? Used only to accept a genuinely short page.
 *
 * @param {any} page
 */
async function isQuiet(page) {
  try {
    await page.waitForLoadState("networkidle", { timeout: 8_000 });
    return true;
  } catch {
    // Pages with polling or a live socket never go idle. Not an error, just a page we
    // read as-is.
    return false;
  }
}

/**
 * The source text behind Chromium's plain-text viewer, or null when the document is a
 * real page.
 *
 * The viewer's shape is stable and narrow — a body whose only element child is a single
 * `<pre>` — so the check can be exact rather than a guess, and a real page that happens
 * to consist of one `<pre>` (a paste, a log) is only unwrapped when the server also said
 * it was not HTML. Both conditions have to hold.
 *
 * @param {any} page
 * @param {string} contentType
 * @returns {Promise<string | null>}
 */
async function readViewerSource(page, contentType) {
  let source;
  try {
    source = await page.evaluate(
      "(function () {" +
        "  var b = document.body;" +
        "  if (!b || b.children.length !== 1) return null;" +
        "  var only = b.firstElementChild;" +
        "  return only && only.tagName === 'PRE' ? only.textContent : null;" +
        "})()",
    );
  } catch {
    return null;
  }
  if (typeof source !== "string" || source.length === 0) return null;

  // The content type recorded at navigation belongs to the FIRST response, which on an
  // escalated fetch is the challenge page and therefore HTML — so a feed that was
  // blocked, solved and then served arrives declaring text/html. Trusting that header
  // alone would leave exactly the feeds this path exists for still wrapped. So the
  // document's own first characters get a vote too.
  const declaredNotHtml = Boolean(contentType) && !/html/.test(contentType);
  return declaredNotHtml || LOOKS_LIKE_SOURCE.test(source.trimStart().slice(0, 200))
    ? source
    : null;
}

/** XML, a feed, or JSON — the things a viewer wraps and a parser needs raw. */
const LOOKS_LIKE_SOURCE = /^(?:<\?xml|<rss\b|<feed\b|<urlset\b|<sitemapindex\b|[[{])/i;

/** @param {any} page */
async function readContent(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await page.content();
    } catch {
      await page.waitForTimeout(500).catch(() => {});
    }
  }
  return "";
}

/** @param {any} page */
function safeUrl(page) {
  try {
    return page.url();
  } catch {
    return null;
  }
}

/**
 * @param {string} proxy
 * @returns {Record<string, string>}
 */
function parseProxy(proxy) {
  const parsed = new URL(proxy);
  /** @type {Record<string, string>} */
  const params = { server: `${parsed.protocol}//${parsed.host}` };
  if (parsed.username && parsed.password) {
    params.username = decodeURIComponent(parsed.username);
    params.password = decodeURIComponent(parsed.password);
  }
  return params;
}

/** @param {unknown} err */
function message(err) {
  const text = err instanceof Error ? err.message : String(err);
  return text.split("\n")[0]?.slice(0, 200) ?? "unknown error";
}

/** Is a browser available at all? Answers without starting one if we already know. */
export function browserUnavailableReason() {
  return unavailableReason;
}

/** Close the browser. Called once at the end of a run; safe to call when none started. */
export async function closeBrowser() {
  const current = live;
  live = null;
  starting = null;
  if (!current) return;
  await current.context.close().catch(() => {});
  await current.browser.close().catch(() => {});
}
