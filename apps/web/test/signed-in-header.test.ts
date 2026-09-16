/**
 * Who the header thinks is reading, and who is allowed to see that answer.
 *
 * Reported from the live site: signed in on the board, open any listing, and the header says
 * "Sign in" again. The tracker becomes unreachable from the page that would make you want it.
 *
 * It was on TEN server-rendered pages — every opportunity, category, country and organisation
 * page — and the cause was not an oversight. Those pages set `public, s-maxage=900`, and the
 * detail page said so plainly:
 *
 *   "this page deliberately does not read the session (it is the same for every reader, which
 *    is what makes it edge-cacheable)"
 *
 * That reasoning is right. A page carrying somebody's name must never land in a shared cache,
 * and `Vary: Cookie` is not strong enough to lean on — Cloudflare honours it for very little.
 * So the safe half was done and the useful half was skipped.
 *
 * The board had always done both, because it decides them together. The fix is to make that
 * inseparable everywhere: `cachePolicyFor(response, user, sharedPolicy)` sets the shared policy
 * for an anonymous reader and `private` the moment there is a user, so the dangerous
 * combination — a name in the markup and `public` on the response — cannot be expressed.
 *
 * These are structural checks. They hold without a database, they cover all ten pages rather
 * than the one that was reported, and they fail if the eleventh forgets.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { cachePolicyFor } from "../src/lib/auth";

const PAGES = new URL("../src/pages/", import.meta.url).pathname;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const read = (f: string) => readFileSync(f, "utf8");
const astro = walk(PAGES).filter((f) => f.endsWith(".astro"));

/** Server-rendered pages that put the shared layout — and therefore the header — on screen. */
const ssrPagesWithHeader = astro
  .filter((f) => {
    const text = read(f);
    return text.includes("prerender = false") && /<Base\b/.test(text);
  })
  // `/signin` is the page for not being signed in. It is the one header in the product with a
  // reason to ignore the session, and the redirect on success means nobody stays to read it.
  .filter((f) => !f.endsWith("signin.astro"));

describe("the header on a server-rendered page", () => {
  it("covers the pages this was reported on", () => {
    // A floor, so a regex that quietly stops matching cannot make the suite pass by
    // measuring nothing.
    expect(ssrPagesWithHeader.length).toBeGreaterThan(10);
  });

  it("knows who is reading", () => {
    // `user={...}`, not `user={user}`: the public profile page calls its session `viewer`,
    // which is a better name there. The rule is that the prop is passed, not what it is called.
    const anonymous = ssrPagesWithHeader.filter((f) => !/user=\{/.test(read(f)));
    expect(anonymous.map((f) => f.slice(PAGES.length))).toEqual([]);
  });

  it("gives every <Base> on the page the same answer", () => {
    // The opportunity page renders one layout for a found record and another for a 404. The
    // first fix reached only the first of them, and a reader who mistyped a slug was signed
    // out again.
    const mismatched = ssrPagesWithHeader.filter((f) => {
      const text = read(f);
      return (text.match(/<Base\b/g) ?? []).length !== (text.match(/user=\{/g) ?? []).length;
    });
    expect(mismatched.map((f) => f.slice(PAGES.length))).toEqual([]);
  });

  it("never marks a page that carries a person publicly cacheable", () => {
    // Setting the header by hand is fine when the value is `private` — many authenticated
    // pages do, and no shared cache will ever hold them. What must not exist on a page that
    // renders the header is a hand-written PUBLIC policy, because that is the half of the
    // decision that was made without consulting the other half.
    const risky = ssrPagesWithHeader.filter((f) => {
      const text = read(f);
      return [...text.matchAll(/headers\.set\(\s*"cache-control",([\s\S]{0,160}?)\);/g)].some(
        (m) => m[1]!.includes("public"),
      );
    });
    expect(risky.map((f) => f.slice(PAGES.length))).toEqual([]);
  });
});

describe("cachePolicyFor", () => {
  const policy = (user: unknown) => {
    const response = { headers: new Headers() };
    cachePolicyFor(response, user, "public, s-maxage=900, stale-while-revalidate=3600");
    return response.headers.get("cache-control");
  };

  it("keeps the shared policy for a reader it knows nothing about", () => {
    // Which is where edge caching earns its keep: crawlers, shared links, the first visit
    // from a search result.
    // Both spellings of "nobody": a page that resolved no session, and one that never looked.
    expect(policy(null)).toBe("public, s-maxage=900, stale-while-revalidate=3600");
    expect(policy(undefined)).toBe("public, s-maxage=900, stale-while-revalidate=3600");
  });

  it("goes private the moment the page carries a person", () => {
    expect(policy({ display_name: "A Builder" })).toBe("private, max-age=0, must-revalidate");
  });

  it("takes the board's other reason not to share", () => {
    // A `/` shaped by the reader's profile country or the edge's country hint is not the `/`
    // the next reader should be handed, even with nobody signed in.
    const response = { headers: new Headers() };
    cachePolicyFor(response, null, "public, s-maxage=300", true);
    expect(response.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
  });

  it("never leaves a personalised response publicly cacheable", () => {
    for (const user of [{ display_name: null }, { display_name: "" }, { id: "x" }]) {
      expect(policy(user), JSON.stringify(user)).not.toContain("public");
    }
  });
});
