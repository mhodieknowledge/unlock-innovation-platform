/**
 * Bot-wall detection. OPPORTUNITY_INGESTION.md §4.2.
 *
 * These tests are written against the 2026-09-15 production run, where 53 of 53
 * documents came back unusable and every one of them was logged as `extraction_failed`.
 * Three different things were actually happening, and the point of this module is to
 * tell them apart, so the cases below are the real bodies those sources served.
 *
 * The two-sided risk is what most of these are about. A detector that fires too
 * readily sends every Cloudflare-fronted page — a large share of the registry — through
 * a browser it does not need, at fifteen seconds each against a batch tier budgeted for
 * eight Actions minutes a day. A detector that fires too rarely reproduces the silent
 * failure. So both directions are tested, not just the catches.
 */

import { describe, expect, it } from "vitest";

import { THIN_TEXT_CHARS, detectChallenge, looksUnrendered, stillChallenged } from "../src/challenge.mjs";

/** The exact body scholarshipregion.com served, with a 202, on 2026-09-15. */
const SGCAPTCHA =
  '<html><head><link rel="icon" href="data:;"><meta http-equiv="refresh" ' +
  'content="0;/.well-known/sgcaptcha/?r=%2Fmcat&y=ipr:35.226.34.3:1789472387.159"></meta></head></html>';

const REAL_PAGE = `<!DOCTYPE html><html><head><title>Gates Cambridge Scholarship 2027</title></head>
<body><main><h1>Gates Cambridge Scholarship</h1><p>${"Applications close on 3 December 2026. ".repeat(40)}</p></main></body></html>`;

describe("detectChallenge", () => {
  it("catches the interstitial that a 2xx hid", () => {
    // The failure this module exists for: HTTP said 202, the pipeline believed it, and
    // the empty body reached extraction as a document.
    const verdict = detectChallenge({ status: 202, body: SGCAPTCHA, contentType: "text/html" });
    expect(verdict.challenged).toBe(true);
    expect(verdict.vendor).toBe("sucuri");
    expect(verdict.renderable).toBe(true);
  });

  it("catches a Cloudflare challenge by its cType marker", () => {
    const body = `<html><head><title>Just a moment...</title></head><body>
      <script>window._cf_chl_opt={cType: 'managed'};</script></body></html>`;
    const verdict = detectChallenge({ status: 403, body });
    expect(verdict.challenged).toBe(true);
    expect(verdict.vendor).toBe("cloudflare");
  });

  it("catches a wall that only announces itself in a header", () => {
    const verdict = detectChallenge({
      status: 403,
      body: "",
      headers: { "CF-Mitigated": "challenge" },
    });
    expect(verdict.challenged).toBe(true);
    expect(verdict.vendor).toBe("cloudflare");
  });

  it("treats a bare 403 as a wall worth a browser", () => {
    // TechCabal and Techpoint answered exactly this. Nothing in the body identifies a
    // vendor, and the likeliest cause is the runner's IP, which a render can change.
    const verdict = detectChallenge({ status: 403, body: "" });
    expect(verdict.challenged).toBe(true);
    expect(verdict.vendor).toBeNull();
    expect(verdict.renderable).toBe(true);
  });

  it("leaves authentication alone", () => {
    // §2.1 rule 2. Kaggle's 401 must stay a plain error: a browser must never be used
    // to get round a credential, so 401 is excluded from escalation at the source.
    for (const status of [401, 407]) {
      const verdict = detectChallenge({ status, body: "" });
      expect(verdict.challenged).toBe(false);
      expect(verdict.renderable).toBe(false);
    }
  });

  it("does not send a rendered Cloudflare page to a browser it does not need", () => {
    // The Disrupt Africa case. The challenge-platform script sits on pages CF has
    // already served; treating it as a wall cost a 15-second render to re-fetch 3,485
    // characters that plain HTTP had already returned.
    const body = `${REAL_PAGE}<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>`;
    const verdict = detectChallenge({ status: 200, body, contentType: "text/html", textLength: 3485 });
    expect(verdict.challenged).toBe(false);
  });

  it("does promote that same weak marker when the document is empty", () => {
    const body = `<html><body><div id="app"></div>
      <script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></body></html>`;
    const verdict = detectChallenge({ status: 200, body, contentType: "text/html", textLength: 12 });
    expect(verdict.challenged).toBe(true);
    expect(verdict.vendor).toBe("cloudflare");
  });

  it("leaves an ordinary page alone", () => {
    const verdict = detectChallenge({
      status: 200,
      body: REAL_PAGE,
      contentType: "text/html",
      textLength: 1600,
    });
    expect(verdict.challenged).toBe(false);
    expect(verdict.vendor).toBeNull();
  });

  it("leaves a feed alone", () => {
    const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>Opportunity Desk</title>
      <item><title>Maple Global Innovation Fellowship 2026</title></item></channel></rss>`;
    expect(detectChallenge({ status: 200, body: feed, contentType: "application/rss+xml" }).challenged).toBe(false);
  });

  it("does not mistake a long page that happens to redirect for an interstitial", () => {
    // The short-body bound is what keeps the meta-refresh rule honest: real pages
    // redirect too, and a real one is not 171 bytes.
    const body = `<html><head><meta http-equiv="refresh" content="5;/moved"></head><body>${"x".repeat(4000)}</body></html>`;
    expect(detectChallenge({ status: 200, body, contentType: "text/html" }).challenged).toBe(false);
  });

  it("reports the signal it matched, for the log", () => {
    const verdict = detectChallenge({ status: 202, body: SGCAPTCHA, contentType: "text/html" });
    expect(verdict.signal).toContain("sgcaptcha");
  });
});

describe("looksUnrendered", () => {
  const shell = `<html><head><title>Zindi</title></head><body><div id="root"></div>
    <script>${"window.__INITIAL__=1;".repeat(400)}</script></body></html>`;

  it("spots an application shell that never rendered", () => {
    // Zindi and the GDG chapter directory: a nav bar, an empty container, and the real
    // list fetched afterwards. 398 characters of chrome went to the model.
    expect(looksUnrendered({ status: 200, body: shell, textLength: 398, contentType: "text/html" })).toBe(true);
  });

  it("leaves a page that carries JSON-LD alone", () => {
    // §4.4 gives JSON-LD priority over the model anyway, so the facts are already in
    // hand and a render would buy nothing.
    expect(
      looksUnrendered({ status: 200, body: shell, textLength: 398, contentType: "text/html", jsonLdCount: 2 }),
    ).toBe(false);
  });

  it("leaves a short but real page alone", () => {
    // Short and static. No script stands where its text should be, so there is nothing
    // a browser would add.
    const small = "<html><body><h1>Closed</h1><p>This call has closed.</p></body></html>";
    expect(looksUnrendered({ status: 200, body: small, textLength: 40, contentType: "text/html" })).toBe(false);
  });

  it("spots a shell too small to trip a markup floor", () => {
    // She Code Africa's home page: 1,316 bytes of head, one bundle, and no text. An
    // earlier version of this rule required 4 KB of markup and let it through, which is
    // why the size test above is about script and not about length.
    const tiny =
      '<!doctype html><html lang="en"><head><meta charset="utf-8"/>' +
      '<link rel="icon" href="/favicon.ico"/>' +
      '<link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;700&display=swap" rel="stylesheet"/>' +
      '<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&display=swap" rel="stylesheet"/>' +
      '<meta name="viewport" content="width=device-width,initial-scale=1"/>' +
      '<meta name="theme-color" content="#000000"/>' +
      '<meta name="description" content="We\u2019re a non-profit Organisation equipping African girls and women ' +
      'with access to digital skills in technology and fostering economic independence."/>' +
      '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png"/>' +
      '<link rel="manifest" href="/manifest.json"/><title>She Code Africa</title>' +
      '<script defer="defer" src="/static/js/main.4f2a9c1b.js"></script>' +
      '<link href="/static/css/main.8d3e0f21.css" rel="stylesheet"/>' +
      '</head><body><noscript>You need to enable JavaScript to run this app.</noscript>' +
      '<div id="root"></div></body></html>';
    expect(tiny.length).toBeLessThan(4096);
    expect(looksUnrendered({ status: 200, body: tiny, textLength: 15, contentType: "text/html" })).toBe(true);
  });

  it("leaves a page with real text alone", () => {
    expect(
      looksUnrendered({ status: 200, body: shell, textLength: THIN_TEXT_CHARS, contentType: "text/html" }),
    ).toBe(false);
  });

  it("ignores non-HTML and non-2xx responses", () => {
    expect(looksUnrendered({ status: 200, body: shell, textLength: 10, contentType: "application/json" })).toBe(false);
    expect(looksUnrendered({ status: 404, body: shell, textLength: 10, contentType: "text/html" })).toBe(false);
  });
});

describe("stillChallenged", () => {
  it("sees a wall still standing after a render", () => {
    expect(stillChallenged({ title: "Just a moment...", textLength: 40 })).toBe(true);
    expect(stillChallenged({ title: "Robot Challenge Screen", textLength: 187 })).toBe(true);
  });

  it("accepts the page the solve loop arrived at", () => {
    expect(
      stillChallenged({
        title: "MCAT 2026: Complete Guide | Scholarship Region",
        textLength: 14_127,
        html: REAL_PAGE,
      }),
    ).toBe(false);
  });

  it("does not read an article about Cloudflare as a challenge", () => {
    // Anchoring the title pattern is what makes this pass: a real headline can contain
    // any of these words, and this catalogue carries startup and security news.
    expect(
      stillChallenged({
        title: "Cloudflare says access denied traffic rose in 2026",
        textLength: 5_000,
        html: REAL_PAGE,
      }),
    ).toBe(false);
  });

  it("holds a page that kept the challenge script and has no content", () => {
    const body = `<html><body><script>window._cf_chl_opt={cType: 'managed'};</script></body></html>`;
    expect(stillChallenged({ title: "", textLength: 0, html: body })).toBe(true);
  });
});
