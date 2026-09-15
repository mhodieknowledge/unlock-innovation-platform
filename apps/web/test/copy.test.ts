/**
 * The copy review, as a test. Phase 11's "copy review for the voice rules", against
 * DESIGN_SYSTEM.md §6's copy rules and CONTENT_AND_LAUNCH.md §4's voice.
 *
 *   §6: "explain what happened and what to do; never apologise; never use 'Oops'; never blame the
 *   user." §6.4: "never an illustration (bytes), never a mascot, never 'Nothing here yet!'."
 *   CONTENT_AND_LAUNCH.md §4: "plain, specific, unexcited. Enthusiasm reads as sales; specificity
 *   reads as respect."
 *
 * A human read every one of these strings while writing them. This is the part a human cannot do
 * again on every commit: catch the exclamation mark, the "sorry", the "please try again", the
 * emoji, the "Oops" that arrives in a hurry six months from now. It reads the page sources rather
 * than rendered output so it covers every branch, including the error states that are hard to
 * reach.
 *
 * It checks WORDS, not tone. Tone is still a human's job, and RUNBOOK §15 says so.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..", "src");

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

const FILES = walk(SRC).filter((file) => /\.(astro|svelte|ts)$/.test(file));

/**
 * The text a reader sees, with the code and the comments removed.
 *
 * Without this the audit fails on its own explanations — a comment saying "never write Oops" is
 * not an "Oops" in the interface. Attribute values, class names and imports go too, since a
 * banned word inside a Tailwind class or a URL is not copy.
 */
function visibleText(source: string): string {
  let text = source;
  // Frontmatter and TS blocks keep their string literals (flash messages live there), but lose
  // comments.
  text = text.replace(/\/\*[\s\S]*?\*\//g, " ");
  text = text.replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  // Class lists, hrefs, imports and JSON keys are not prose.
  text = text.replace(/class(?:Name)?=(?:"[^"]*"|\{`[^`]*`\}|'[^']*')/g, " ");
  text = text.replace(/\b(?:href|src|action|name|id|for|datetime|aria-labelledby|aria-controls)="[^"]*"/g, " ");
  text = text.replace(/^\s*import[^\n]*$/gm, " ");
  return text;
}

interface Rule {
  /** What the copy must never contain. */
  pattern: RegExp;
  why: string;
  /** Files where the word is legitimate for a stated reason. */
  allow?: RegExp;
}

const RULES: Rule[] = [
  {
    pattern: /\bOops\b|\bWhoops\b|\bUh[- ]oh\b/i,
    why: "DESIGN_SYSTEM.md §6: never use \"Oops\".",
  },
  {
    pattern: /\b(?:we(?:'re| are) sorry|sorry(?:,| about| for)|we apologise|apologies)\b/i,
    why: "§6: never apologise. Say what happened and what to do.",
  },
  {
    pattern: /Nothing here yet/i,
    why: "§6.4 names this phrase specifically as the thing an empty state must not say.",
  },
  {
    pattern: /\b(?:you (?:did|entered|typed) (?:something|it|this) wrong|invalid input|bad request)\b/i,
    why: "§6: never blame the user.",
  },
  {
    pattern: /\b(?:exciting|amazing|awesome|incredible|passionate|revolutionary|game[- ]chang)/i,
    why: "CONTENT_AND_LAUNCH.md §4: plain, specific, unexcited. Enthusiasm reads as sales.",
  },
  {
    /*
     * Pictographic emoji only. The design system's own glyph vocabulary is typographic and
     * REQUIRED: §8 says "every colour-coded state has a glyph and a label", and §6.2 spells the
     * set out — ● ◐ ○ for team and project states, ✓ ✕ ？ for verdicts, ⚠ for a low-confidence
     * rule in the review card. Those are letterforms doing a job. A 🎉 is a picture doing a mood.
     */
    pattern: /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}]/u,
    why: "No pictographic emoji in the interface: it is an image in a text channel and renders differently on every platform.",
  },
  {
    pattern: /\bplease wait\b|\bloading\.\.\./i,
    why: "§6.3: never a spinner on a full page, and never a page whose content is the word \"loading\".",
  },
  {
    pattern: /\bclick here\b/i,
    why: "§8: a link's text has to say where it goes; \"click here\" says nothing to a screen reader reading links out of context.",
  },
  {
    pattern: /\bsimply\b|\bjust click\b|\beasy\b/i,
    why: "§6: a word that tells the reader the thing they are struggling with is easy.",
  },
];

describe("copy review (DESIGN_SYSTEM.md §6, CONTENT_AND_LAUNCH.md §4)", () => {
  it("has files to review (guards against a vacuous pass)", () => {
    expect(FILES.length).toBeGreaterThan(40);
    // And the extractor must not have stripped everything: a known string has to survive it.
    const base = readFileSync(resolve(SRC, "layouts", "Base.astro"), "utf8");
    expect(visibleText(base)).toContain("Skip to content");
  });

  for (const rule of RULES) {
    it(`no page ${rule.pattern} — ${rule.why}`, () => {
      const offenders: string[] = [];
      for (const file of FILES) {
        if (rule.allow?.test(file)) continue;
        const text = visibleText(readFileSync(file, "utf8"));
        const match = rule.pattern.exec(text);
        if (match) {
          const at = Math.max(0, match.index - 60);
          offenders.push(`${relative(SRC, file)}: …${text.slice(at, match.index + 60).replace(/\s+/g, " ")}…`);
        }
      }
      expect(offenders, `${rule.why}\n${offenders.join("\n")}`).toEqual([]);
    });
  }

  it("uses no exclamation mark anywhere a reader can see one", () => {
    // Not in the rules table above because the pattern needs the operators stripped: `!important`,
    // `!==`, `!x` and JSX negations are code, and only prose is being reviewed.
    const offenders: string[] = [];
    for (const file of FILES) {
      const text = visibleText(readFileSync(file, "utf8"))
        .replace(/!==?/g, " ")
        .replace(/!important/g, " ")
        // A leading `!` is a negation: `!found.ok`, `{!country ? …}`.
        .replace(/!(?=[A-Za-z_$({[/])/g, " ")
        // A trailing `!` after an identifier or a bracket is TypeScript's non-null assertion:
        // `words[0]!`, `status!.requests_in`, `queue!`. Code, not punctuation.
        .replace(/(?<=[\w\]\)])!/g, " ")
        // And a `!` inside a regex character class is a pattern, not a sentence. Escapes are
        // honoured so `[_*[\]()~`>#+\-=|{}.!\\]` — the Telegram escape set — is removed whole.
        .replace(/\[(?:[^\]\\]|\\.)*\]/g, " ");
      const match = /!/.exec(text);
      if (match) {
        const at = Math.max(0, match.index - 60);
        offenders.push(`${relative(SRC, file)}: …${text.slice(at, match.index + 40).replace(/\s+/g, " ")}…`);
      }
    }
    expect(offenders, `an exclamation mark in the interface:\n${offenders.join("\n")}`).toEqual([]);
  });
});

describe("the states §6 requires, on the surfaces that have them", () => {
  const read = (path: string) => readFileSync(resolve(SRC, path), "utf8");

  it("every listing surface has an empty state with one action", () => {
    // §6.4: "one sentence naming the situation, one action". Asserted as the presence of the
    // branch and of a link inside it — a list page with no empty branch renders a bare page,
    // which is the state §6.4 exists to prevent.
    const surfaces = [
      "pages/index.astro",
      "pages/opportunities/index.astro",
      "pages/countries/[slug].astro",
      "pages/categories/[slug].astro",
      "pages/tracker.astro",
    ];
    for (const surface of surfaces) {
      const source = read(surface);
      expect(source, `${surface} has no empty-state branch`).toMatch(
        /length === 0|length > 0 \?|rows\.length|listed\.length|entries\.length/,
      );
      expect(source, `${surface}'s empty state offers nothing to do`).toMatch(/href=/);
    }
  });

  it("names the situation rather than the error, on the degraded paths", () => {
    // §6.5: a degraded search is "silent — results render with a meta note". The list page says
    // what it can do, not what broke.
    const list = read("pages/opportunities/index.astro");
    expect(list).toContain("Search is limited at the moment");
    // What the reader is told, not what the code calls it: the page imports reportError and has an
    // `error` variable, and neither is copy. §6.5's rule is about the sentence on the screen.
    expect(visibleText(list)).not.toMatch(/\b(?:an error occurred|something went wrong|failed to load)\b/i);

    // §6.5's 404 copy: what it is, and a way on.
    const detail = read("pages/opportunities/[slug].astro");
    expect(detail).toContain("That opportunity isn't here");
    expect(detail).toContain("merged into another listing");
  });

  it("never shows a spinner on a full page (§6.3)", () => {
    for (const file of FILES) {
      const source = readFileSync(file, "utf8");
      expect(source, `${relative(SRC, file)} animates a spinner`).not.toMatch(
        /animate-spin|spinner|<Spinner/,
      );
    }
  });

  it("keeps every touch target at 44px (§8)", () => {
    // §8: "Touch targets >= 44x44px". min-h-11 is 44px on this scale; h-11 is the fixed-height
    // form-control variant. A button with neither is a target nobody can reliably hit on a phone.
    const offenders: string[] = [];
    for (const file of FILES.filter((f) => /\.(astro|svelte)$/.test(f))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/<button\b[^>]*?>/gs)) {
        const tag = match[0];
        if (!/(?:min-)?h-11|min-h-\[44px\]|h-full/.test(tag)) {
          offenders.push(`${relative(SRC, file)}: ${tag.replace(/\s+/g, " ").slice(0, 90)}`);
        }
      }
    }
    expect(offenders, `buttons under 44px:\n${offenders.join("\n")}`).toEqual([]);
  });
});
