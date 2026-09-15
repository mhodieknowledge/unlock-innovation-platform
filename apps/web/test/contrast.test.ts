/**
 * Contrast, computed from the tokens. DESIGN_SYSTEM.md §8's "WCAG 2.1 AA", and Phase 11's
 * "contrast verification of every token pair".
 *
 * WHY NOT AXE. axe measures contrast by sampling rendered pixels through a canvas, which means it
 * needs a real browser, and it only ever checks the pairs that happen to appear on a page it was
 * pointed at. This reads the token file, parses the hex values, and computes the WCAG ratio for
 * every pair the design system permits — including the ones no page has used yet, which are
 * exactly the ones a future page will get wrong.
 *
 * The thresholds are the standard's, not ours: 4.5:1 for text, 3:1 for large text and for the
 * visual boundary of a user interface component (SC 1.4.11). Nothing here is rounded up: a pair at
 * 4.49 fails.
 *
 * Two pairs are deliberately exempt and named as such — see the hairline note below.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKENS = readFileSync(resolve(HERE, "..", "src", "styles", "tokens.css"), "utf8");

/** Every `--color-*` token in the file, by name. */
function readColours(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of css.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    out[match[1]!] = match[2]!;
  }
  return out;
}

const COLOURS = readColours(TOKENS);

/** WCAG 2.x relative luminance, with the sRGB transfer function spelled out. */
function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const channel = parseInt(full.slice(i, i + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  const [hi, lo] = x > y ? [x, y] : [y, x];
  return (hi + 0.05) / (lo + 0.05);
}

const contrast = (fg: string, bg: string): number => {
  const a = COLOURS[fg];
  const b = COLOURS[bg];
  if (!a || !b) throw new Error(`unknown token: ${!a ? fg : bg}`);
  return ratio(a, b);
};

/** Every surface a token can sit on. §3.1's three grounds. */
const GROUNDS = ["paper", "surface", "sunken"] as const;

/** Tokens used as TEXT. §3: ink ramp, brand, and the eligibility ramp's foreground half. */
const TEXT_TOKENS = [
  "ink",
  "ink-2",
  "ink-3",
  "absolute",
  "brand",
  "brand-ink",
  "eligible",
  "likely",
  "unclear",
  "noteligible",
  "danger",
  "warning",
  "success",
];

/** Each verdict colour also sits on its own wash. §3.3's ramp is used as a pair. */
const WASH_PAIRS: [string, string][] = [
  ["eligible", "eligible-wash"],
  ["likely", "likely-wash"],
  ["unclear", "unclear-wash"],
  ["noteligible", "noteligible-wash"],
  ["brand", "brand-wash"],
  ["brand-ink", "brand-wash"],
  ["ink", "brand-wash"],
  ["ink-2", "brand-wash"],
  ["danger", "noteligible-wash"],
  ["warning", "unclear-wash"],
  ["success", "eligible-wash"],
  ["ink", "eligible-wash"],
  ["ink", "unclear-wash"],
  ["ink", "noteligible-wash"],
  ["ink-2", "sunken"],
];

describe("the token file parsed at all", () => {
  it("found the palette (guards against a vacuous pass)", () => {
    // If the regex stopped matching, every assertion below would pass on an empty object.
    expect(Object.keys(COLOURS).length).toBeGreaterThan(15);
    for (const token of [...TEXT_TOKENS, ...GROUNDS, "line", "line-strong"]) {
      expect(COLOURS[token], `--color-${token} is missing from tokens.css`).toBeTruthy();
    }
  });

  it("computes known ratios correctly", () => {
    // Black on white is 21:1 exactly, and a colour against itself is 1:1. If the maths is wrong,
    // every other number here is wrong in the same direction.
    expect(ratio("#000000", "#ffffff")).toBeCloseTo(21, 2);
    expect(ratio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(ratio("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("text on every ground meets AA (4.5:1)", () => {
  for (const token of TEXT_TOKENS) {
    for (const ground of GROUNDS) {
      it(`${token} on ${ground}`, () => {
        const value = contrast(token, ground);
        expect(value, `${token} on ${ground} is ${value.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

describe("the pairs the design system uses together", () => {
  for (const [fg, bg] of WASH_PAIRS) {
    it(`${fg} on ${bg}`, () => {
      const value = contrast(fg, bg);
      expect(value, `${fg} on ${bg} is ${value.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("surface on brand, which is every primary button", () => {
    expect(contrast("surface", "brand")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("paper", "brand")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("non-text contrast (SC 1.4.11)", () => {
  it("the focus ring is visible against every ground", () => {
    // §8: "visible focus (2px --brand, offset 2px, never removed)". A focus ring is non-text
    // information that identifies state, so 3:1 is the floor.
    for (const ground of GROUNDS) {
      const value = contrast("brand", ground);
      expect(value, `focus ring on ${ground} is ${value.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    }
  });

  it("the boundary of every form control meets 3:1", () => {
    // --color-line-strong draws every input, select, textarea and bordered button. It measured
    // 1.68:1 until Phase 11 — a field a sighted reader could see and a low-vision reader could not.
    for (const ground of GROUNDS) {
      const value = contrast("line-strong", ground);
      expect(value, `control boundary on ${ground} is ${value.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    }
  });

  /**
   * The one documented exemption, asserted rather than assumed.
   *
   * --color-line is the hairline between rows and fact-grid cells. SC 1.4.11 exempts pure
   * decoration, and nothing a reader must find or operate is identified by this line alone — the
   * rows are identified by their content, their spacing and their headings. The assertion below
   * pins that intent: if the hairline is ever put on a control boundary, the control-boundary test
   * above is the one that has to pass, and this test documents which token is which.
   */
  it("the hairline is decorative, and only the hairline", () => {
    expect(contrast("line", "surface")).toBeLessThan(3);
    expect(contrast("line-strong", "surface")).toBeGreaterThanOrEqual(3);
  });

  it("no form control is drawn with the decorative hairline", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = resolve(HERE, "..", "src");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        return statSync(full).isDirectory() ? walk(full) : [full];
      });

    const offenders: string[] = [];
    for (const file of walk(src).filter((f) => /\.(astro|svelte)$/.test(f))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/<(input|select|textarea)\b[^>]*?>/gs)) {
        if (/border-line(?!-strong)/.test(match[0])) {
          offenders.push(`${file.replace(src, "src")}: <${match[1]}>`);
        }
      }
    }
    expect(offenders, `these controls use the decorative hairline:\n${offenders.join("\n")}`).toEqual([]);
  });
});

describe("motion respects prefers-reduced-motion (§7)", () => {
  it("removes every animation and transition, globally and once", () => {
    // §7 `[PR]`: "prefers-reduced-motion: reduce removes all of the above, leaving instant state
    // changes." Declared once in the base layer rather than per component, so a new component
    // cannot forget it.
    expect(TOKENS).toContain("@media (prefers-reduced-motion: reduce)");
    const block = TOKENS.slice(TOKENS.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(block).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
    expect(block).toMatch(/scroll-behavior:\s*auto\s*!important/);
    // It has to apply to everything, including pseudo-elements.
    expect(block).toContain("*::before");
    expect(block).toContain("*::after");
  });

  it("never removes a focus outline", () => {
    // §8: focus is "never removed". `outline: none` anywhere in the styles would do exactly that.
    expect(TOKENS).not.toMatch(/outline:\s*(none|0)/);
    expect(TOKENS).toContain(":focus-visible");
  });
});
