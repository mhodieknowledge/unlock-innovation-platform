#!/usr/bin/env node
/**
 * Byte-budget enforcement. PRODUCT_SPEC.md §25.1, SYSTEM_ARCHITECTURE.md §3.5.
 *
 * Invariant 5: never exceed a byte budget. IMPLEMENTATION_PLAN.md §16 rule 5:
 * "CI enforces it; do not add an override." There is deliberately no override
 * flag in this script.
 *
 * Measures gzipped transfer for every built route:
 *   - the HTML document (inlined CSS included, since we inline stylesheets)
 *   - every external stylesheet it links
 *   - the full transitive import closure of every module script it loads
 *
 * The closure matters: measuring only the scripts named in the HTML would miss
 * a framework runtime pulled in by an island, which is exactly the cost that
 * ADR 0001 was decided on.
 *
 * Usage:
 *   node scripts/byte-budget.mjs            check apps/web/dist
 *   node scripts/byte-budget.mjs --selftest prove the checker rejects a bundle
 *                                           that is deliberately over budget
 */

import { gzipSync } from "node:zlib";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, resolve, dirname, posix } from "node:path";
import { tmpdir } from "node:os";

const KB = 1024;

/**
 * Budgets come from packages/config/src/route-budgets.json — the SINGLE source of
 * truth, read by this script and by packages/config alike.
 *
 * This script used to carry its own hand-copied duplicate of the table, with a
 * comment claiming a drift test in packages/config kept the two honest. There was
 * no such test. The first time routes were added to the TypeScript copy and not
 * this one, seven pages silently fell back to the absolute ceiling — a 250 KB
 * budget standing in for a 100 KB one, reported as a pass. Read the file.
 */
const BUDGET_TABLE = JSON.parse(
  readFileSync(
    join(dirname(new URL(import.meta.url).pathname), "..", "packages", "config", "src", "route-budgets.json"),
    "utf8",
  ),
);

const ROUTE_BUDGETS = BUDGET_TABLE.routes.map((r) => ({
  pattern: r.pattern,
  label: r.label,
  totalBytes: r.totalKb * KB,
  jsBytes: r.jsKb * KB,
}));

const ABSOLUTE = {
  totalBytes: BUDGET_TABLE.absolute.totalKb * KB,
  jsBytes: BUDGET_TABLE.absolute.jsKb * KB,
};

const gz = (buf) => gzipSync(buf, { level: 9 }).length;
const fmt = (n) => `${(n / KB).toFixed(1)} KB`;

async function htmlFiles(dir) {
  const out = [];
  async function walk(d) {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.name.endsWith(".html")) out.push(p);
    }
  }
  await walk(dir);
  return out.sort();
}

function routeOf(distDir, file) {
  let rel = relative(distDir, file).split(/[\\/]/).join("/");
  rel = rel.replace(/index\.html$/, "").replace(/\.html$/, "");
  rel = rel.replace(/\/$/, "");
  return "/" + rel;
}

/** `*` matches exactly one path segment. Longest literal prefix wins. */
function budgetFor(route) {
  const matches = ROUTE_BUDGETS.filter((b) => {
    const rx = new RegExp(
      "^" + b.pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]+") + "$",
    );
    return rx.test(route);
  });
  if (matches.length === 0) return null;
  return matches.sort(
    (a, b) => b.pattern.replace(/\*/g, "").length - a.pattern.replace(/\*/g, "").length,
  )[0];
}

function localAssets(html, attr) {
  const rx =
    attr === "src"
      ? /<script[^>]+src=["']([^"']+)["']/g
      : /<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/g;
  const found = [];
  for (const m of html.matchAll(rx)) {
    const url = m[1];
    if (url && !/^https?:|^\/\//.test(url)) found.push(url);
  }
  // Stylesheets can also appear with href before rel.
  if (attr === "href") {
    for (const m of html.matchAll(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']stylesheet["']/g)) {
      const url = m[1];
      if (url && !/^https?:|^\/\//.test(url)) found.push(url);
    }
  }
  return [...new Set(found)];
}

function toFile(distDir, url) {
  const clean = url.split("?")[0].split("#")[0];
  return resolve(distDir, clean.replace(/^\//, ""));
}

/** Follow static import/export specifiers transitively. */
function importClosure(distDir, entryUrls) {
  const seen = new Set();
  const queue = [...entryUrls];
  while (queue.length) {
    const url = queue.shift();
    const file = toFile(distDir, url);
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    const rx = /(?:from|import|export\s+\*\s+from)\s*["']([^"']+\.m?js)["']|import\(\s*["']([^"']+\.m?js)["']\s*\)/g;
    for (const m of src.matchAll(rx)) {
      const spec = m[1] ?? m[2];
      if (!spec) continue;
      const resolved = spec.startsWith(".")
        ? "/" + posix.normalize(posix.join(posix.dirname(url), spec)).replace(/^\//, "")
        : spec;
      queue.push(resolved);
    }
  }
  return [...seen];
}

async function measure(distDir) {
  const rows = [];
  for (const file of await htmlFiles(distDir)) {
    const html = readFileSync(file, "utf8");
    const route = routeOf(distDir, file);

    const htmlBytes = gz(Buffer.from(html));

    let cssBytes = 0;
    for (const href of localAssets(html, "href")) {
      const f = toFile(distDir, href);
      if (existsSync(f)) cssBytes += gz(readFileSync(f));
    }

    const jsFiles = importClosure(distDir, localAssets(html, "src"));
    const jsBytes = jsFiles.reduce((sum, f) => sum + gz(readFileSync(f)), 0);

    rows.push({
      route,
      htmlBytes,
      cssBytes,
      jsBytes,
      totalBytes: htmlBytes + cssBytes + jsBytes,
      jsFileCount: jsFiles.length,
    });
  }
  return rows;
}

function report(rows) {
  const violations = [];
  console.log("");
  console.log("Byte budgets — gzipped transfer, first visit (PRODUCT_SPEC.md §25.1)");
  console.log("");
  console.log(
    "  " +
      "route".padEnd(44) +
      "total".padStart(10) +
      "budget".padStart(10) +
      "js".padStart(10) +
      "budget".padStart(10),
  );
  console.log("  " + "-".repeat(84));

  const unbudgeted = [];

  for (const row of rows) {
    const budget = budgetFor(row.route);
    if (!budget) unbudgeted.push(row.route);
    const totalCap = budget?.totalBytes ?? ABSOLUTE.totalBytes;
    const jsCap = budget?.jsBytes ?? ABSOLUTE.jsBytes;

    const overTotal = row.totalBytes > totalCap;
    const overJs = row.jsBytes > jsCap;
    const overAbsTotal = row.totalBytes > ABSOLUTE.totalBytes;
    const overAbsJs = row.jsBytes > ABSOLUTE.jsBytes;

    if (overTotal || overJs || overAbsTotal || overAbsJs) {
      violations.push({ row, totalCap, jsCap, overTotal, overJs, overAbsTotal, overAbsJs });
    }

    const mark = overTotal || overJs || overAbsTotal || overAbsJs ? "✗" : "✓";
    console.log(
      `${mark} ` +
        row.route.slice(0, 43).padEnd(44) +
        fmt(row.totalBytes).padStart(10) +
        fmt(totalCap).padStart(10) +
        fmt(row.jsBytes).padStart(10) +
        fmt(jsCap).padStart(10) +
        (budget ? "" : "   (no explicit budget — absolute ceiling applied)"),
    );
  }

  console.log("");

  if (rows.length === 0) {
    console.log("No HTML routes found. The build layout probably changed —");
    console.log("measuring nothing must never look like passing.");
    return false;
  }

  // A route with no explicit budget is a failure, not a silent fallback to the
  // absolute ceiling. This is how a build-layout change gets caught: when the
  // adapter moved output into dist/client, every route stopped matching its
  // pattern and the old behaviour reported "within budget" while measuring the
  // wrong thing entirely.
  if (unbudgeted.length > 0) {
    console.log(`${unbudgeted.length} route(s) have NO explicit budget:`);
    for (const route of unbudgeted) console.log(`  ${route}`);
    console.log("");
    console.log("Add a pattern to ROUTE_BUDGETS, or check whether the build");
    console.log("output layout moved and these route paths are wrong.");
    return false;
  }

  if (violations.length === 0) {
    console.log(`All ${rows.length} route(s) within budget.`);
    return true;
  }

  console.log(`${violations.length} route(s) OVER BUDGET — invariant 5 (README.md §5):`);
  for (const v of violations) {
    if (v.overTotal)
      console.log(
        `  ${v.row.route}: total ${fmt(v.row.totalBytes)} exceeds ${fmt(v.totalCap)} by ${fmt(v.row.totalBytes - v.totalCap)}`,
      );
    if (v.overJs)
      console.log(
        `  ${v.row.route}: JS ${fmt(v.row.jsBytes)} exceeds ${fmt(v.jsCap)} by ${fmt(v.row.jsBytes - v.jsCap)} (${v.row.jsFileCount} module(s))`,
      );
    if (v.overAbsTotal)
      console.log(`  ${v.row.route}: breaches the absolute ${fmt(ABSOLUTE.totalBytes)} ceiling`);
    if (v.overAbsJs)
      console.log(`  ${v.row.route}: breaches the absolute ${fmt(ABSOLUTE.jsBytes)} JS ceiling`);
  }
  console.log("");
  console.log("There is no override. Reduce the payload or move work to the server.");
  return false;
}

/**
 * Phase 0 acceptance criterion: "CI **fails** a deliberately oversized bundle."
 * Builds a synthetic dist with one route 400 KB over and asserts a failure, then
 * one comfortably inside budget and asserts a pass. Tests the checker, not the app.
 */
async function selftest() {
  const dir = mkdtempSync(join(tmpdir(), "budget-selftest-"));
  try {
    // Oversized: an /opportunities/* route (120 KB / 30 KB budget) with ~410 KB
    // of low-entropy-resistant JS in a transitive import.
    mkdirSync(join(dir, "opportunities", "too-big"), { recursive: true });
    mkdirSync(join(dir, "_a"), { recursive: true });
    const noise = Array.from(
      { length: 60000 },
      (_, i) => `const v${i}=${Math.sin(i) * 1e9};`,
    ).join("");
    writeFileSync(join(dir, "_a", "huge.js"), `import"./dep.js";${noise}`);
    writeFileSync(join(dir, "_a", "dep.js"), noise);
    writeFileSync(
      join(dir, "opportunities", "too-big", "index.html"),
      `<!doctype html><html><head><title>x</title></head><body><script type="module" src="/_a/huge.js"></script></body></html>`,
    );

    console.log("── self-test 1: a deliberately oversized route must FAIL ──");
    const over = report(await measure(dir));
    if (over) {
      console.error("SELF-TEST FAILED: the checker passed a route that is over budget.");
      return false;
    }
    console.log("  correct: the oversized route was rejected.\n");

    rmSync(join(dir, "opportunities"), { recursive: true, force: true });
    rmSync(join(dir, "_a"), { recursive: true, force: true });

    // Within budget.
    mkdirSync(join(dir, "opportunities", "fine"), { recursive: true });
    writeFileSync(
      join(dir, "opportunities", "fine", "index.html"),
      `<!doctype html><html><head><title>x</title></head><body><p>${"a".repeat(2000)}</p></body></html>`,
    );

    console.log("── self-test 2: a route inside budget must PASS ──");
    const under = report(await measure(dir));
    if (!under) {
      console.error("SELF-TEST FAILED: the checker rejected a route that is within budget.");
      return false;
    }
    console.log("  correct: the in-budget route was accepted.\n");
    console.log("Self-test passed: the byte-budget gate both rejects and accepts correctly.");
    return true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
if (args.includes("--selftest")) {
  process.exit((await selftest()) ? 0 : 1);
}

const root = join(dirname(new URL(import.meta.url).pathname), "..");
const explicit = args.find((a) => !a.startsWith("--"));

// @astrojs/cloudflare emits dist/client (static assets and HTML) alongside
// dist/server (the worker). Measure the client directory, since that is what a
// browser actually transfers. Falls back to dist for a flat layout.
const candidates = explicit
  ? [explicit]
  : [
      join(root, "apps", "web", "dist", "client"),
      join(root, "apps", "web", "dist"),
    ];

const distDir = candidates.map((c) => resolve(c)).find((c) => existsSync(c));

if (!distDir) {
  console.error(`No build output found. Looked in:\n  ${candidates.join("\n  ")}\nRun the build first.`);
  process.exit(1);
}

console.log(`Measuring ${relative(root, distDir) || distDir}`);

process.exit(report(await measure(distDir)) ? 0 : 1);
