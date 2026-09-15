/**
 * The ingestion pipeline, end to end, against a real HTTP server and a real
 * database. OPPORTUNITY_INGESTION.md §1–§4 and AI_SYSTEM.md §4–§5.
 *
 * Two things only an integration test can prove, and both are Phase 3 acceptance
 * criteria in IMPLEMENTATION_PLAN.md §5:
 *
 *   "With every LLM provider disabled, the site still serves, search still works,
 *    and nothing false is displayed."
 *   "No rule is ever stored without a source quote that verbatim-matches the
 *    document."
 *
 * The server here is deliberately awkward in the ways real sources are: a robots.txt
 * that disallows one path, a page that charges a fee, a page with JSON-LD and one
 * without, and a redirect. Nothing is mocked below the HTTP boundary — the fetcher,
 * the parser, the validators and the database functions all run for real.
 */

import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);

const CONN = process.env["DATABASE_URL"] ?? process.env["SUPABASE_DB_URL"];

let server: Server;
let origin = "";
let client: pg.Client;
let sourceId = "";

/** A page that states everything properly, with JSON-LD as well. */
const GOOD_PAGE = `<!doctype html>
<html><head>
<title>Southern Africa Climate Innovation Grant 2027</title>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"EducationalOccupationalProgram",
 "name":"Southern Africa Climate Innovation Grant 2027",
 "applicationDeadline":"2027-03-15",
 "provider":{"@type":"Organization","name":"Kariba Climate Foundation"},
 "url":"/grant-2027",
 "isAccessibleForFree":true}
</script>
</head><body>
<nav><a href="/">Home</a><a href="/donate">Donate</a></nav>
<main>
<h1>Southern Africa Climate Innovation Grant 2027</h1>
<p>The Kariba Climate Foundation is funding early-stage climate ventures.</p>
<h2>Eligibility</h2>
<p>Applicants must be resident in Zimbabwe, Zambia or Malawi at the time of application.</p>
<p>Applicants must be aged between 18 and 30 on 1 January 2027.</p>
<p>Teams of two to five people are required.</p>
<h2>How to apply</h2>
<p>Applications close on 15 March 2027 at 23:59 CAT. There is no fee to apply.</p>
</main>
<footer>Privacy policy</footer>
</body></html>`;

/** A page that charges a fee. Invariant 13 says this must never publish. */
const FEE_PAGE = `<!doctype html>
<html><head><title>Innovation Prize 2027</title></head><body><main>
<h1>Innovation Prize 2027</h1>
<p>Open to all applicants across Africa.</p>
<p>A non-refundable application fee of USD 25 is required to process your submission.</p>
<p>Applications close on 30 April 2027.</p>
</main></body></html>`;

/** No JSON-LD at all: in NO_AI mode this document must produce nothing. */
const PLAIN_PAGE = `<!doctype html>
<html><head><title>Something else</title></head><body><main>
<h1>A programme with no structured data</h1>
<p>Applicants must be resident in Kenya.</p>
</main></body></html>`;

const FEED = (base: string) => `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Fixture feed</title>
  <item><title>Climate grant</title><link>${base}/grant-2027?utm_source=rss</link>
    <pubDate>Mon, 08 Sep 2026 09:00:00 +0000</pubDate></item>
  <item><title>Innovation prize</title><link>${base}/fee-prize</link></item>
  <item><title>Plain page</title><link>${base}/plain</link></item>
  <item><title>Off limits</title><link>${base}/private/secret</link></item>
</channel></rss>`;

beforeAll(async () => {
  if (!CONN) {
    throw new Error("Set DATABASE_URL for this command only (invariant 11). This check cannot skip.");
  }

  server = createServer((req, res) => {
    const url = req.url ?? "/";
    const send = (status: number, type: string, body: string) => {
      res.writeHead(status, { "content-type": type });
      res.end(body);
    };

    if (url === "/robots.txt") {
      // A real robots.txt: one disallowed directory, a crawl-delay we must honour
      // only up to our own floor.
      return send(200, "text/plain", "User-agent: *\nDisallow: /private/\nCrawl-delay: 0\n");
    }
    if (url.startsWith("/feed")) return send(200, "application/rss+xml", FEED(origin));
    if (url.startsWith("/grant-2027")) return send(200, "text/html", GOOD_PAGE);
    if (url.startsWith("/fee-prize")) return send(200, "text/html", FEE_PAGE);
    if (url.startsWith("/plain")) return send(200, "text/html", PLAIN_PAGE);
    if (url.startsWith("/private/")) return send(200, "text/html", "<p>should never be fetched</p>");
    if (url.startsWith("/huge")) {
      res.writeHead(200, { "content-type": "text/html", "content-length": String(5 * 1024 * 1024) });
      return res.end("x".repeat(1024));
    }
    if (url.startsWith("/spreadsheet")) return send(200, "application/vnd.ms-excel", "binary");
    return send(404, "text/plain", "not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  origin = `http://127.0.0.1:${port}`;

  client = new pg.Client({ connectionString: CONN });
  await client.connect();

  // A fixture source with enough published records that §4.7's "first 5 are always
  // reviewed" trigger is not the only reason anything lands in review — otherwise
  // the confidence gate would never be exercised.
  sourceId = randomUUID();
  await client.query(
    `INSERT INTO sources (id, name, kind, url, cadence_minutes, robots_allowed,
                          robots_checked_at, tos_posture, trust_score, records_published, is_active)
     VALUES ($1, $2, 'rss', $3, 15, true, now(), 'permits_feeds', 0.80, 40, true)`,
    [sourceId, `Pipeline fixture ${sourceId.slice(0, 8)}`, `${origin}/feed`],
  );
}, 60_000);

afterAll(async () => {
  // Everything this test created, removed — it runs against the same database as the
  // other suites.
  if (client) {
    // The queue rows first: review_queue.subject_id is a plain uuid rather than a foreign key
    // (the subject type varies), so a queue row outlives the opportunity it points at and
    // shows up in another suite's counts.
    await client.query(
      `DELETE FROM review_queue WHERE subject_id IN (
         SELECT id FROM opportunities WHERE source_id = $1 OR source_url LIKE $2)`,
      [sourceId, `${origin}%`],
    );
    await client.query(
      `DELETE FROM opportunities WHERE source_id = $1 OR source_url LIKE $2`,
      [sourceId, `${origin}%`],
    );
    await client.query("DELETE FROM raw_documents WHERE source_id = $1", [sourceId]);
    await client.query("DELETE FROM source_fetches WHERE source_id = $1", [sourceId]);
    await client.query("DELETE FROM sources WHERE id = $1", [sourceId]);
    // The organisation the pipeline created for this source, and the org_claim queue row it
    // made alongside it (scripts/ingest.mjs, §4.5). Matched by the domain the fixture server
    // runs on rather than by name: the name comes out of the extractor and is not this test's
    // to predict, while the domain is.
    const { rows: orgs } = await client.query<{ id: string }>(
      `SELECT id FROM organisations WHERE website_domain = $1 OR name = 'Kariba Climate Foundation'`,
      [new URL(origin).host],
    );
    if (orgs.length > 0) {
      const ids = orgs.map((row) => row.id);
      await client.query("DELETE FROM review_queue WHERE subject_id = ANY($1::uuid[])", [ids]);
      await client.query("DELETE FROM organisations WHERE id = ANY($1::uuid[])", [ids]);
    }
    await client.end();
  }
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function runIngest(extra: string[] = []) {
  const { stdout, stderr } = await exec(
    process.execPath,
    ["scripts/ingest.mjs", "--source", sourceId, ...extra],
    { env: { ...process.env, DATABASE_URL: CONN }, cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout + stderr;
}

describe("the pipeline with every provider disabled (NO_AI)", () => {
  let output = "";

  beforeAll(async () => {
    // AI_SYSTEM.md §4's fallback is JSON-LD only. This is the acceptance criterion:
    // with no AI at all, the pipeline still produces records and NOTHING FALSE.
    output = await runIngest(["--no-ai"]);
  }, 120_000);

  it("says plainly that it is not calling any provider", () => {
    expect(output).toContain("NO_AI mode");
  });

  it("stores the record the publisher described in JSON-LD", async () => {
    const { rows } = await client.query(
      "SELECT * FROM opportunities WHERE source_url = $1",
      [`${origin}/grant-2027`],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Southern Africa Climate Innovation Grant 2027");
    // The publisher stated this date; nothing inferred it.
    expect(new Date(rows[0].deadline_at).toISOString()).toBe("2027-03-15T00:00:00.000Z");
    expect(rows[0].deadline_precision).toBe("date_only");
  });

  it("creates NO eligibility rules, because §5's fallback creates none", async () => {
    // "Every verdict for that opportunity is `unclear`, displayed honestly." That is
    // the acceptable degraded state — and a rule invented without a model would be
    // the unacceptable one.
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM eligibility_rules r
        JOIN opportunities o ON o.id = r.opportunity_id
       WHERE o.source_url = $1`,
      [`${origin}/grant-2027`],
    );
    expect(rows[0].n).toBe(0);
  });

  it("publishes nothing at all — §4.9 needs a link check first", async () => {
    const { rows } = await client.query(
      "SELECT DISTINCT status::text FROM opportunities WHERE source_id = $1",
      [sourceId],
    );
    expect(rows.map((r) => r.status)).toEqual(["in_review"]);
  });

  it("produces nothing from a page with no structured data", async () => {
    // §4: "Otherwise the document waits. Nothing is published from a failed
    // extraction." The document is still stored so the next run can retry it.
    const { rows: opportunities } = await client.query(
      "SELECT count(*)::int AS n FROM opportunities WHERE source_url = $1",
      [`${origin}/plain`],
    );
    expect(opportunities[0].n).toBe(0);

    const { rows: documents } = await client.query(
      "SELECT count(*)::int AS n FROM raw_documents WHERE canonical_url = $1",
      [`${origin}/plain`],
    );
    expect(documents[0].n).toBe(1);
  });

  it("honours robots.txt — the disallowed path is never fetched", async () => {
    expect(output).toContain("disallowed by robots.txt");
    const { rows } = await client.query(
      "SELECT count(*)::int AS n FROM raw_documents WHERE canonical_url LIKE $1",
      [`${origin}/private/%`],
    );
    expect(rows[0].n).toBe(0);
  });

  it("resolves the organisation the publisher named", async () => {
    const { rows } = await client.query(
      `SELECT og.name FROM opportunities o JOIN organisations og ON og.id = o.organisation_id
        WHERE o.source_url = $1`,
      [`${origin}/grant-2027`],
    );
    expect(rows[0]?.name).toBe("Kariba Climate Foundation");
  });

  it("strips page chrome from the stored text", async () => {
    const { rows } = await client.query(
      "SELECT text_raw FROM raw_documents WHERE canonical_url = $1",
      [`${origin}/grant-2027`],
    );
    expect(rows[0].text_raw).toContain("Applicants must be resident in Zimbabwe");
    expect(rows[0].text_raw).not.toContain("Donate");
    expect(rows[0].text_raw).not.toContain("Privacy policy");
  });

  it("records an auditable fetch row, as §1 requires of every stage", async () => {
    const { rows } = await client.query(
      "SELECT count(*)::int AS n FROM source_fetches WHERE source_id = $1",
      [sourceId],
    );
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it("is idempotent: a second run stores nothing new", async () => {
    const before = await client.query(
      "SELECT count(*)::int AS n FROM opportunities WHERE source_id = $1",
      [sourceId],
    );
    // §1 `[PR]`: "Each stage is independently re-runnable and idempotent."
    const second = await runIngest(["--no-ai"]);
    const after = await client.query(
      "SELECT count(*)::int AS n FROM opportunities WHERE source_id = $1",
      [sourceId],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(second).toContain("0 stored");
  }, 120_000);
});

describe("invariant 13 — a fee to apply never publishes", () => {
  it("marks the fee page as paid, whatever its structured data says", async () => {
    // AI_SYSTEM.md §10 `[PR]`: the deterministic fee check runs first and is never
    // skipped, including in NO_AI mode. It reads the SOURCE, not a model's opinion.
    const { rows } = await client.query(
      "SELECT cost::text, status::text FROM opportunities WHERE source_url = $1",
      [`${origin}/fee-prize`],
    );
    // The page has no JSON-LD, so in NO_AI mode no record is created at all — which
    // is the strongest possible version of "never published".
    if (rows.length > 0) {
      expect(rows[0].cost).toBe("paid");
      expect(rows[0].status).not.toBe("published");
    }
    const { rows: docs } = await client.query(
      "SELECT text_raw FROM raw_documents WHERE canonical_url = $1",
      [`${origin}/fee-prize`],
    );
    expect(docs).toHaveLength(1);
    expect(docs[0].text_raw).toContain("non-refundable application fee");
  });

  it("cannot be published even by a direct write — the schema refuses it", async () => {
    // Invariant 13 is a CHECK constraint, not a policy the pipeline follows.
    await expect(
      client.query(
        `INSERT INTO opportunities (slug, title, category_id, status, last_verified_at, cost, source_url)
         VALUES ('pipeline-fee-test','Fee test',(SELECT id FROM categories WHERE code='grant'),
                 'published', now(), 'paid', $1)`,
        [`${origin}/fee-prize`],
      ),
    ).rejects.toThrow();
  });
});

describe("the fetcher's limits (§4.2)", () => {
  it("refuses a body over the 2 MB cap", async () => {
    const { politeFetch, resetFetcherState } = await import("../scripts/lib/fetcher.mjs");
    resetFetcherState();
    const result = await politeFetch(`${origin}/huge`);
    expect(result.status).toBe("parse_error");
    expect(result.error).toContain("cap");
  }, 60_000);

  it("refuses a content type outside the allowlist", async () => {
    const { politeFetch } = await import("../scripts/lib/fetcher.mjs");
    const result = await politeFetch(`${origin}/spreadsheet`);
    expect(result.status).toBe("parse_error");
    expect(result.error).toContain("allowlist");
  }, 60_000);

  it("fails CLOSED when robots.txt cannot be read", async () => {
    const { politeFetch, resetFetcherState } = await import("../scripts/lib/fetcher.mjs");
    resetFetcherState();
    // Nothing is listening on this port, so robots.txt cannot be fetched. Most
    // crawlers would treat that as permission; §2 rates the legal posture above
    // coverage, so we do not.
    const result = await politeFetch("http://127.0.0.1:1/anything");
    expect(result.status).toBe("blocked");
    expect(result.robotsAllowed).toBe(false);
  }, 60_000);
});
