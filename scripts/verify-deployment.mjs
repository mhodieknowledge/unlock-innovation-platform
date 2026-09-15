#!/usr/bin/env node
/**
 * Prove a deployment works, from outside it.
 *
 * Everything else in this repository tests the code. This tests the DEPLOYMENT: the headers a real
 * Cloudflare response carries, the routes a real crawler would fetch, the auth gate as an
 * anonymous stranger meets it, and the transferred weight of the homepage over the wire. None of
 * that is knowable from a unit test — the middleware that sets the security headers on SSR
 * responses exists precisely because a test read a file and believed it.
 *
 * Run: npm run verify:deployment -- https://mbele-web.mbele.workers.dev
 *
 * Exit code is 0 only when every REQUIRED check passes. Checks marked informational print their
 * finding and never fail the run — a catalogue with nothing published yet is a true state, not a
 * broken deployment.
 */

import { gunzipSync } from "node:zlib";

import { SECURITY_HEADERS } from "../packages/config/src/security-headers.mjs";

const base = (process.argv[2] ?? "").replace(/\/$/, "");
if (!base) {
  console.error("Usage: npm run verify:deployment -- https://your-deployment");
  process.exit(1);
}

let failures = 0;
let checks = 0;

const pass = (label, detail = "") => {
  checks += 1;
  console.log(`  ✓ ${label}${detail ? `  ${detail}` : ""}`);
};
const fail = (label, detail) => {
  checks += 1;
  failures += 1;
  console.log(`  ✗ ${label}  ${detail}`);
};
const note = (label, detail) => console.log(`  · ${label}  ${detail}`);

/**
 * A fetch that never throws.
 *
 * An unreachable deployment is a result, not a crash: DNS that has not propagated, a Worker that
 * was never published, a domain pointed somewhere else. Each of those should read as a failed
 * check with a reason, because a stack trace tells the operator nothing they can act on.
 */
async function get(path, options = {}) {
  try {
    return await fetch(`${base}${path}`, {
      redirect: "manual",
      headers: { "accept-encoding": "gzip", ...(options.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    // Named rather than `any`: the three places Node puts the reason, in the order they are
    // worth reading. `cause.code` is the errno — ENOTFOUND, ECONNREFUSED — and the only one of
    // them an operator can act on directly.
    const thrown = /** @type {{ cause?: { code?: string }; name?: string; message?: string }} */ (
      error
    );
    return {
      status: 0,
      unreachable: String(thrown.cause?.code ?? thrown.name ?? thrown.message ?? error),
      headers: new Headers(),
      text: async () => "",
    };
  }
}

console.log(`\nVerifying ${base}\n`);

{
  // One reachability probe first, so an unpublished Worker produces one clear sentence rather
  // than forty identical failures.
  const probe = await get("/api/health");
  if (probe.status === 0) {
    // `in`, because the successful branch of get() returns a Response and a Response has no
    // reason to explain.
    const reason = "unreachable" in probe ? probe.unreachable : "no response";
    console.log(`  ✗ ${base} is not reachable  (${reason})`);
    console.log("\nNothing else can be checked until it responds.\n");
    process.exit(1);
  }
}

/* ── The page that has to work ─────────────────────────────────────────────── */

console.log("The board");
{
  const response = await get("/");
  if (response.status === 200) pass("responds 200");
  else fail("responds 200", `got ${response.status}`);

  const html = await response.text();

  if (/<h1[^>]*>/.test(html)) pass("renders a heading server-side");
  else fail("renders a heading server-side", "no <h1> in the HTML");

  // The whole premise: content arrives in the HTML, not after a bundle runs.
  if (html.includes("Everything here is open")) pass("carries its own copy, with no JavaScript");
  else fail("carries its own copy", "the headline is missing from the server HTML");

  if (html.includes("Nothing is published yet")) {
    note("the catalogue is empty", "the board says so plainly, which is the honest state");
  } else if (/Closing soonest/.test(html)) {
    note("the board has rows", "the catalogue has published records");
  }

  // SECURITY.md §5, on a response the Worker built. `_headers` cannot reach this.
  const missing = Object.keys(SECURITY_HEADERS).filter((name) => !response.headers.get(name));
  if (missing.length === 0) pass("carries every security header", `${Object.keys(SECURITY_HEADERS).length} of them`);
  else fail("carries every security header", `missing: ${missing.join(", ")}`);

  const csp = response.headers.get("content-security-policy") ?? "";
  if (csp && !/unsafe-inline/.test(csp)) pass("CSP has no unsafe-inline");
  else fail("CSP has no unsafe-inline", csp ? "it does" : "there is no CSP at all");

  // PRODUCT_SPEC.md §25.1: the homepage budget is 120 KB gzipped on a first visit. This is the
  // HTML alone — the stylesheet and any island are separate requests — so it is a floor, not the
  // whole figure, and the CI gate remains the enforcement.
  const bytes = Number(response.headers.get("content-length") ?? 0);
  if (bytes > 0) note("homepage HTML over the wire", `${(bytes / 1024).toFixed(1)} KB`);
}

/* ── Liveness ──────────────────────────────────────────────────────────────── */

console.log("\nHealth");
{
  const response = await get("/api/health");
  const body = await response.text();
  if (response.status === 200 && body.includes('"status":"ok"')) pass("reports ok");
  else fail("reports ok", `${response.status} ${body.slice(0, 120)}`);

  if ((response.headers.get("cache-control") ?? "").includes("no-store")) pass("is never cached");
  else note("cache-control", response.headers.get("cache-control") ?? "(none)");
}

/* ── What a crawler finds ──────────────────────────────────────────────────── */

console.log("\nCrawlability (SEO.md §5)");
{
  const robots = await get("/robots.txt");
  const body = await robots.text();
  if (robots.status === 200) pass("robots.txt responds");
  else fail("robots.txt responds", `got ${robots.status}`);

  if (body.includes(`Sitemap: ${base}/sitemap.xml`)) pass("names the sitemap, absolutely");
  else fail("names the sitemap", body.match(/Sitemap:.*/)?.[0] ?? "no Sitemap line");

  for (const path of ["/tracker", "/you", "/admin", "/api"]) {
    if (body.includes(`Disallow: ${path}`)) pass(`disallows ${path}`);
    else fail(`disallows ${path}`, "not in robots.txt");
  }

  const index = await get("/sitemap.xml");
  const xml = await index.text();
  if (index.status === 200 && xml.includes("<sitemapindex")) pass("sitemap index is valid XML");
  else fail("sitemap index", `${index.status} ${xml.slice(0, 120)}`);

  const segments = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  if (segments.length === 6) pass("indexes six segments");
  else fail("indexes six segments", `found ${segments.length}`);

  // Every segment has to be fetchable, or Search Console reports the index as broken.
  for (const url of segments) {
    const segment = await fetch(url);
    const text = await segment.text();
    if (segment.status === 200 && text.includes("<urlset")) {
      const count = (text.match(/<loc>/g) ?? []).length;
      pass(`  ${new URL(url).pathname}`, `${count} URL(s)`);
    } else {
      fail(`  ${new URL(url).pathname}`, `${segment.status}`);
    }
  }
}

/* ── The private surfaces, as a stranger meets them ────────────────────────── */

console.log("\nThe auth gate (SEO.md §1's third layer)");
{
  for (const path of ["/tracker", "/you", "/you/profile", "/admin"]) {
    const response = await get(path);
    if (response.status === 302 || response.status === 303) {
      const to = response.headers.get("location") ?? "";
      if (to.includes("/signin")) pass(`${path} sends a stranger to sign in`);
      else fail(`${path} redirects`, `to ${to}, not /signin`);
    } else if (response.status === 404) {
      pass(`${path} is not there for a stranger`);
    } else if (response.status === 200) {
      const html = await response.text();
      // A 200 is only acceptable if it is noindex AND shows no personal data.
      if (/noindex/.test(html)) pass(`${path} answers noindex`);
      else fail(`${path} answers 200`, "with no noindex — a private page a crawler may index");
    } else {
      note(`${path}`, `${response.status}`);
    }
  }
}

/* ── The offline and installable surface ───────────────────────────────────── */

console.log("\nPWA (PRODUCT_SPEC.md §25.3)");
{
  const manifest = await get("/manifest.webmanifest");
  const text = await manifest.text();
  try {
    const parsed = JSON.parse(text);
    if (parsed.name && parsed.icons?.length > 0) pass("manifest is valid and has an icon");
    else fail("manifest", "parsed but incomplete");
  } catch {
    fail("manifest is valid JSON", text.slice(0, 120));
  }

  // The substring each content-type must contain. Two of them are a subtype alone, because a
  // script is served as `text/javascript` by one host and `application/javascript` by another and
  // neither is wrong. A previous version of this took `type.split("/").pop()`, which is
  // string | undefined and made `tsc` right to complain; splitting unconditionally then made
  // `includes(undefined)` false and failed both scripts on a deployment that was serving them
  // correctly. A check that fails on a working site is as much a bug as one that passes on a
  // broken one.
  for (const [path, type] of [
    ["/sw.js", "javascript"],
    ["/sw-routes.js", "javascript"],
    ["/offline", "text/html"],
    ["/og.png", "image/png"],
    ["/icon.svg", "image/svg"],
  ]) {
    const response = await get(path);
    const contentType = response.headers.get("content-type") ?? "";
    const want = type.includes("/") ? type.slice(type.indexOf("/") + 1) : type;
    if (response.status === 200 && contentType.includes(want)) {
      pass(`${path} served as ${contentType.split(";")[0]}`);
    } else {
      fail(`${path}`, `${response.status} ${contentType}`);
    }
  }

  const sw = await get("/sw.js");
  if ((sw.headers.get("cache-control") ?? "").includes("no-cache")) pass("the worker is never cached");
  else fail("the worker is never cached", sw.headers.get("cache-control") ?? "(none)");
}

/* ── The rest of the public surface ────────────────────────────────────────── */

console.log("\nPublic routes");
{
  for (const path of [
    "/opportunities",
    "/countries",
    "/categories",
    "/privacy",
    "/terms",
    "/anti-scam",
    "/verification",
    "/bot",
    "/feeds/closing-soon.xml",
  ]) {
    const response = await get(path);
    if (response.status === 200) pass(path);
    else fail(path, `got ${response.status}`);
  }

  // A country page for a country that exists, and a 404 for one that does not.
  const zw = await get("/countries/zimbabwe");
  if (zw.status === 200) pass("/countries/zimbabwe");
  else fail("/countries/zimbabwe", `got ${zw.status}`);

  const nowhere = await get("/countries/atlantis");
  if (nowhere.status === 404) pass("/countries/atlantis is an honest 404");
  else fail("/countries/atlantis", `got ${nowhere.status}, which is a soft 404`);
}

/* ── Published addresses that can actually receive ─────────────────────────── */

console.log("\nPublished contact addresses");
{
  // PRIVACY_AND_COMPLIANCE.md §7 item 4 requires "a named contact address for privacy requests,
  // published and monitored". OPPORTUNITY_INGESTION.md §2.1 rule 8 requires a published takedown
  // address with a 48-hour SLA, and rule 3 requires the crawler's User-Agent to point at a page
  // explaining it.
  //
  // With no BRAND_DOMAIN configured, `packages/config/src/brand.mjs` falls back to
  // `example.invalid` — a reserved TLD that cannot resolve, by RFC 2606. So the live privacy
  // policy asks people to write to an address that will bounce, and the crawler identifies
  // itself with a URL that does not exist. This is one repository VARIABLE away from correct
  // (BRAND_DOMAIN), and it fails rather than notes because a policy page naming an unreachable
  // address is a compliance statement that is not true.
  const placeholder = /example\.invalid/;
  for (const path of ["/privacy", "/terms", "/anti-scam", "/bot", "/verification", "/content-policy", "/.well-known/security.txt"]) {
    const body = await (await get(path)).text();
    if (!placeholder.test(body)) pass(`${path} names a reachable domain`);
    else fail(`${path}`, "publishes an @example.invalid address — set the BRAND_DOMAIN variable");
  }
}

console.log(
  `\n${failures === 0 ? "All" : `${checks - failures} of`} ${checks} checks passed${failures ? ` — ${failures} FAILED` : ""}.\n`,
);
process.exit(failures === 0 ? 0 : 1);
