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

import { readdirSync, readFileSync, statSync } from "node:fs";
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

/**
 * The AI task vocabulary, which is written down in three places.
 *
 * A `summarise` task meant a prompt file, provider rows in the seed, and a `chainFor` call in
 * the runner — and a CHECK constraint from migration 0013 that listed six task names and had
 * never heard of it. A CHECK violation is an error rather than a conflict, so `ON CONFLICT DO
 * NOTHING` does not absorb it: `npm run db:seed` failed at 005_ai_providers.sql, and a run
 * that got past it would have found `ai_chain_for('summarise')` empty and reported "no
 * provider" forever.
 *
 * Measured, not assumed: seeded into a real Postgres at migration 0034 the seed fails on the
 * constraint, and at 0035 it inserts. This test is the cheap version of that, so the next task
 * cannot be added to two of the three places.
 */
describe("the ai_providers task vocabulary", () => {
  const sql = (file: string) => readFileSync(join(ROOT, "supabase", file), "utf8");

  /** Task names the seed inserts. */
  const seeded = (): string[] => {
    const rows = [...sql("seed/005_ai_providers.sql").matchAll(/^\s*\('[a-z_]+',\s*'([a-z_]+)'/gm)];
    return [...new Set(rows.flatMap((row) => (row[1] === undefined ? [] : [row[1]])))];
  };

  /** Task names the constraint permits, from the LAST migration that defines it. */
  const permitted = (): string[] => {
    const migrations = readdirSync(join(ROOT, "supabase", "migrations"))
      .filter((name) => name.endsWith(".up.sql"))
      .sort();
    let latest: string | null = null;
    for (const name of migrations) {
      const text = sql(join("migrations", name));
      const match = /task\s+IN\s*\(([^)]+)\)/.exec(text);
      if (match?.[1] !== undefined) latest = match[1];
    }
    if (latest === null) throw new Error("no migration defines the task CHECK");
    return [...latest.matchAll(/'([a-z_]+)'/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
  };

  it("permits every task the seed inserts", () => {
    const rejected = seeded().filter((task) => !permitted().includes(task));
    expect(rejected, "the seed would fail the CHECK constraint on these").toEqual([]);
  });

  it("has a provider row for every task the runner asks for", () => {
    // A task with a chain of zero is not a failure anywhere: runTask reports no provider and
    // the caller carries on, which is right for a missing key and wrong for a task nobody
    // ever seeded.
    const runner = readFileSync(join(ROOT, "scripts", "ingest.mjs"), "utf8");
    const asked = [...runner.matchAll(/chainFor\("([a-z_]+)"/g)].flatMap((m) =>
      m[1] === undefined ? [] : [m[1]],
    );
    expect(asked.length, "the runner should ask for chains").toBeGreaterThan(2);
    expect(asked.filter((task) => !seeded().includes(task))).toEqual([]);
  });

  it("has a prompt file for every task that takes one", () => {
    // `moderate` and `query` are called from the request tier, not from here.
    const runner = readFileSync(join(ROOT, "scripts", "ingest.mjs"), "utf8");
    const prompts = [...runner.matchAll(/prompt\("([a-z_.0-9]+)"/g)].flatMap((m) =>
      m[1] === undefined ? [] : [m[1]],
    );
    const missing = prompts.filter(
      (name) => !statSync(join(ROOT, "prompts", `${name}.md`), { throwIfNoEntry: false })?.isFile(),
    );
    expect(missing, "these prompts are loaded but no file exists").toEqual([]);
  });
});

/**
 * A summary that does not say who wrote it.
 *
 * PRODUCT_SPEC.md §14's hard AI rules, marked [PR]: "Anything AI-derived and user-visible is
 * labelled and carries its source quote", and the same list puts "AI-written opportunity
 * descriptions presented as ours" under explicitly NOT built. The opportunity page rendered
 * `summary` as an unlabelled paragraph under the title — the position and voice of an editorial
 * standfirst — for every listing the pipeline has ever described.
 *
 * The label is conditional on `summary_source`, so it is only as true as that column. This
 * asserts the column is written wherever the summary is: a write that sets one and not the
 * other makes the page's label a guess, and it would be a silent one.
 */
describe("who wrote the summary", () => {
  const runners = ["scripts/ingest.mjs", "scripts/reverify.mjs", "scripts/dedupe.mjs"];

  it("is recorded by every statement that writes a summary", () => {
    for (const file of runners) {
      const text = readFileSync(join(ROOT, file), "utf8");
      // Every SQL statement in these files is a template or plain string; a write to `summary`
      // appears either as an INSERT column list or as `SET summary =`.
      const writes = [
        ...text.matchAll(/INSERT INTO opportunities[\s\S]{0,400}?\)/g),
        ...text.matchAll(/UPDATE opportunities[\s\S]{0,200}?SET [\s\S]{0,200}?WHERE/g),
      ].filter((match) => /\bsummary\b/.test(match[0]));

      for (const write of writes) {
        expect(
          write[0],
          `${file}: this writes summary without summary_source, so the page's label is a guess`,
        ).toMatch(/summary_source/);
      }
    }
  });

  it("is rendered as a label on the page that shows the summary", () => {
    const page = readFileSync(
      join(ROOT, "apps", "web", "src", "pages", "opportunities", "[slug].astro"),
      "utf8",
    );
    expect(page).toMatch(/summary_source/);
    // The label says who wrote it and points at the organiser's own words, because "labelled"
    // without a route to the source is a disclaimer rather than an attribution.
    expect(page).toMatch(/not by the organiser/);
    expect(page).toMatch(/Read their own description/);
  });

  it("is selected by the query that feeds that page", () => {
    // The label cannot be conditional on a column the query does not ask for, and PostgREST
    // returns undefined rather than failing for a field left out of the select list — so this
    // would have rendered the label on every record, human-written ones included.
    const db = readFileSync(join(ROOT, "apps", "web", "src", "lib", "db.ts"), "utf8");
    expect(db).toMatch(/summary,\s*summary_source/);
  });
});

/**
 * A COLUMN THE INSERT WRITES AND THE REFRESH PATH DOES NOT.
 *
 * `image_url` (migration 0038) shipped written only by the INSERT in scripts/ingest.mjs. Every
 * record in the catalogue already existed, so every crawl took the `refreshed` branch instead
 * — the UPDATE a few lines above it — and all of them stayed NULL through as many re-crawls as
 * anyone cared to run. The column was there, the card was there, and the board showed category
 * panels for every listing. Nothing failed; it just never filled.
 *
 * That is the shape of the bug worth a test: a write path that exists, runs, succeeds, and
 * quietly omits a field. The summary_source suite above guards the same class for a different
 * column, and this one generalises it — any column the INSERT sets must be set somewhere on the
 * refresh path too, or be listed here as deliberately insert-only with the reason.
 */
describe("what the refresh path forgets", () => {
  /**
   * Columns an INSERT sets that a refresh must NOT re-set, with why. Anything else the INSERT
   * writes has to appear in the UPDATE, or this fails.
   */
  const INSERT_ONLY: Record<string, string> = {
    slug: "a slug is an identity and a URL; changing it on refresh breaks every link to it",
    title: "renaming a listing under a reader is worse than a stale title; a real retitle is a moderation decision",
    summary: "written once by the model; re-writing it on every crawl would re-run the copy check against a moving target",
    summary_source: "travels with summary, which is insert-only",
    category_id: "recategorisation is its own job (--recategorise), with its own acceptance rules",
    organisation_id: "re-attributing a listing to a different body is a moderation decision, not a crawl outcome",
    source_id: "the source that found it does not change",
    raw_document_id: "points at the fetch that created the record",
    eligibility_scope: "changed only through the diff path in reverify, which notifies trackers",
    eligible_countries: "same as eligibility_scope",
    participation_mode: "not re-extracted on the refresh path",
    deadline_timezone: "set from the first extraction; a later crawl has no better answer",
    team_required: "not re-extracted on the refresh path",
    team_size_min: "not re-extracted on the refresh path",
    team_size_max: "not re-extracted on the refresh path",
    prize_amount: "not re-extracted on the refresh path",
    prize_currency: "not re-extracted on the refresh path",
    cost: "invariant 13: a cost change is a moderation event, handled in reverify",
    source_url: "the URL this record was found at; it is the match key for the refresh itself",
    official_url: "not re-extracted on the refresh path",
    status: "publishing and un-publishing are decisions, not crawl outcomes",
    verification: "a verification state is set by the verification pipeline",
    extraction_confidence: "describes the extraction that created the record",
    published_at: "the moment it was published, which does not recur",
  };

  it("sets every column the insert sets, or says why not", () => {
    const text = readFileSync(join(ROOT, "scripts/ingest.mjs"), "utf8");

    const insert = /INSERT INTO opportunities\s*\(([\s\S]*?)\)\s*VALUES/.exec(text);
    expect(insert, "the INSERT into opportunities moved; this test cannot find it").toBeTruthy();
    const inserted = insert![1]!
      .split(",")
      .map((c) => c.replace(/--.*$/gm, "").trim())
      .filter((c) => /^[a-z_]+$/.test(c));
    expect(inserted.length, "parsed no columns out of the INSERT").toBeGreaterThan(20);

    // The refresh branch: the UPDATE that runs when the crawler re-sees a record it has.
    const update = /UPDATE opportunities\s+SET([\s\S]*?)WHERE id = \$1/.exec(text);
    expect(update, "the refresh UPDATE moved; this test cannot find it").toBeTruthy();
    const refreshed = update![1]!;

    const forgotten = inserted.filter(
      (column) => !INSERT_ONLY[column] && !new RegExp(`\\b${column}\\s*=`).test(refreshed),
    );
    expect(
      forgotten,
      `scripts/ingest.mjs: the refresh path never writes these, so they stay at whatever the\n`
        + `first crawl found — forever, for every record that already exists:\n  ${forgotten.join("\n  ")}\n\n`
        + `Either write them in the refresh UPDATE, or add them to INSERT_ONLY with the reason.`,
    ).toEqual([]);
  });

  it("captures a listing's picture on a path that visits records it already has", () => {
    // The INSERT alone reaches only records nobody has seen before. On a catalogue that
    // predates the column, that is none of them.
    const reverify = readFileSync(join(ROOT, "scripts/reverify.mjs"), "utf8");
    expect(reverify, "reverify never captures an og:image").toMatch(/extractImageUrl/);
    expect(reverify, "no backfill job for records that predate the column").toMatch(/image_url IS NULL/);
  });
});
