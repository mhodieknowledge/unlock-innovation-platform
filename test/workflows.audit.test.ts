/**
 * A dropdown option that no step is wired up to run.
 *
 * WHY THIS FILE EXISTS. Run 42 of the Ingestion workflow was dispatched with job
 * `recategorise`, which had just been added to the `workflow_dispatch` choice list. The
 * `case` that dispatches the job had never heard of it, and its last branch was `*)`, so
 * the run executed `npm run reverify -- recategorise` — a subcommand that does not exist.
 * The operator's only signal was a usage line forty seconds in.
 *
 * The dropdown and the `case` are two lists that have to agree, which is the same shape as
 * the taxonomy drift in prompts/extract.v1.md: nobody reads two lists side by side. So this
 * reads them side by side. It is a text audit rather than a run, because running the
 * workflow costs a dispatch and only ever proves one option at a time.
 *
 * It also refuses a wildcard default that succeeds. `*)` may fail loudly — that is how an
 * option added without wiring announces itself — but it must never quietly hand an unknown
 * job to a script that will interpret it as something else.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = join(ROOT, ".github", "workflows", "ingest.yml");
const yaml = readFileSync(WORKFLOW, "utf8");

/**
 * The first capture group of `pattern`, or a failure naming what was being looked for.
 *
 * The alternative is `regex.exec(...)![1]`, and a non-null assertion in a test is a way of
 * asking the compiler to stop checking the thing the test is about: when the workflow's
 * shape changes, the assertion turns a clear "the dispatch case is gone" into a
 * TypeError on undefined.
 */
const capture = (pattern: RegExp, what: string): string => {
  const match = pattern.exec(yaml);
  if (!match || match[1] === undefined) throw new Error(`ingest.yml no longer has ${what}`);
  return match[1];
};

/** The `options: [...]` of the `job` input, in declaration order. */
const dropdownOptions = (): string[] =>
  capture(/options:\s*\[([^\]]+)\]/, "an options list on the job input")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

/**
 * The `case` body of the manual-run step, split into its branches.
 *
 * A branch label may hold several alternatives (`links|reverify|sweep|health`), so the
 * labels are flattened into the set of job names that reach a real command. Comment lines
 * are dropped first: a branch named inside a comment is not a branch.
 */
const wiredJobs = (): { jobs: Set<string>; defaultBody: string } => {
  const lines = capture(/case "\$JOB" in\n([\s\S]*?)\n\s*esac/, "a case dispatching on $JOB")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line));

  const jobs = new Set<string>();
  let defaultBody = "";
  let inDefault = false;
  for (const line of lines) {
    const label = /^\s*([A-Za-z0-9_|-]+)\)/.exec(line)?.[1];
    if (label !== undefined) {
      inDefault = false;
      for (const name of label.split("|")) jobs.add(name);
      continue;
    }
    const wildcard = /^\s*\*\)(.*)$/.exec(line)?.[1];
    if (wildcard !== undefined) {
      // A one-line branch carries its body on the label line — which is precisely how run
      // 42's `*) npm run reverify -- "$JOB"` was written, so missing it would make this
      // test pass on the very thing it exists to catch.
      inDefault = true;
      defaultBody += `${wildcard}\n`;
      continue;
    }
    if (inDefault) defaultBody += `${line}\n`;
  }
  return { jobs, defaultBody };
};

describe("the Ingestion workflow's manual-run dropdown", () => {
  it("offers only jobs that have a branch to run them", () => {
    const { jobs } = wiredJobs();
    const unwired = dropdownOptions().filter((option) => !jobs.has(option));
    expect(unwired, "these options are offered but nothing runs them").toEqual([]);
  });

  it("has no branch for a job the dropdown does not offer", () => {
    // The other direction: dead wiring is a smaller problem than an unwired option, but it
    // is how a renamed job leaves a branch behind that will never be reached again.
    const offered = new Set(dropdownOptions());
    const orphans = [...wiredJobs().jobs].filter((job) => !offered.has(job));
    expect(orphans, "these branches can never be reached from the dropdown").toEqual([]);
  });

  it("fails rather than guessing when the job is unknown", () => {
    const { defaultBody } = wiredJobs();
    expect(defaultBody.trim().length, "there should be a default branch").toBeGreaterThan(0);
    expect(defaultBody).toMatch(/exit 1/);
    // The specific regression: the default must not run a script with "$JOB" as an argument.
    expect(defaultBody).not.toMatch(/npm run/);
  });

  it("names an npm script that exists in every branch", () => {
    const scripts = new Set(
      Object.keys(
        (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
          scripts: Record<string, string>;
        }).scripts,
      ),
    );
    const invoked = [...yaml.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    );
    expect(invoked.length, "the workflow should invoke npm scripts").toBeGreaterThan(5);
    expect(invoked.filter((name) => !scripts.has(name))).toEqual([]);
  });
});

describe("the daily job", () => {
  it("runs the two backfills that a freshly ingested record needs", () => {
    // OPPORTUNITY_INGESTION.md: an API source arrives with no description and, before the
    // taxonomy was repaired, usually no category. Both are cheap and both are pointless if
    // they only ever run when someone remembers to dispatch them by hand.
    const daily = capture(
      /(- name: Sweep staleness and expiry[\s\S]*?)(?=\n      - name: |\n      # )/,
      "a daily sweep step",
    );
    expect(daily).toMatch(/npm run ingest -- --fill-summaries/);
    expect(daily).toMatch(/npm run ingest -- --recategorise/);
  });
});
