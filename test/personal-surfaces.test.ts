/**
 * "Your window" and "What should I do next". PRODUCT_SPEC.md §14.1 and §14.2, both `[PR]`.
 *
 * The caps are the product decision — a feed optimises for time spent, a bounded dated
 * list optimises for something being done — so they are enforced in the database and
 * asserted here rather than trusted to a page template.
 *
 * The other thing asserted here is the authorisation. Both functions take a user id and
 * are SECURITY DEFINER, which without a guard would make them a way to read anyone's
 * recommendations — and those are derived from the eligibility profile, the one thing
 * ADMIN_SYSTEM.md §6 keeps unreadable by every principal including admins.
 */

import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CONN = process.env["DATABASE_URL"] ?? process.env["SUPABASE_DB_URL"];

let client: pg.Client;
const userId = randomUUID();
const otherUserId = randomUUID();
const orgId = randomUUID();
const oppIds: string[] = [];

/** Impersonate a user the way the RLS suite does — the claim auth.uid() reads. */
const actAs = (id: string | null) =>
  id === null
    ? client.query("RESET request.jwt.claim.sub")
    : client.query(`SET request.jwt.claim.sub = '${id}'`);

beforeAll(async () => {
  if (!CONN) {
    throw new Error("Set DATABASE_URL for this command only (invariant 11). This check cannot skip.");
  }
  client = new pg.Client({ connectionString: CONN });
  await client.connect();

  await client.query(
    `INSERT INTO organisations (id, name, slug) VALUES ($1,'Window Fixture Org',$2)`,
    [orgId, `window-fixture-${orgId.slice(0, 8)}`],
  );

  await client.query(
    `INSERT INTO users (id, email, age_confirmed_18, timezone, last_seen_at) VALUES
       ($1,$3,true,'Africa/Harare',now()),
       ($2,$4,true,'Africa/Lagos',now())`,
    [userId, otherUserId, `window-${userId}@example.invalid`, `other-${otherUserId}@example.invalid`],
  );

  await client.query(
    `INSERT INTO eligibility_profiles (user_id, country_of_residence, birth_year, student_status)
     VALUES ($1,'ZW',2000,'undergraduate')`,
    [userId],
  );

  // One africa-wide opportunity, so the country-board fallback has something to return
  // for ANY country. Without it the fallback can legitimately be empty — which is a real
  // state the page handles, but not the one these tests are about.
  const africaWide = randomUUID();
  await client.query(
    `INSERT INTO opportunities
       (id, slug, title, category_id, organisation_id, status, verification, last_verified_at,
        cost, source_url, deadline_at, deadline_precision, published_at, eligibility_scope,
        eligible_countries, link_ok)
     VALUES ($1,$2,'Continent-wide fixture opportunity',
             (SELECT id FROM categories WHERE code='grant'),$3,'published','verified',now(),
             'free',$4, now() + interval '20 days','date_only', now(), 'africa_wide',
             ARRAY[]::char(2)[], true)`,
    [africaWide, `window-fx-wide-${africaWide.slice(0, 8)}`, orgId, `https://window.example/wide`],
  );

  // Twelve opportunities inside the 30-day window, so the cap has something to cap.
  for (let i = 0; i < 12; i += 1) {
    const id = randomUUID();
    oppIds.push(id);
    await client.query(
      `INSERT INTO opportunities
         (id, slug, title, category_id, organisation_id, status, verification, last_verified_at,
          cost, source_url, deadline_at, deadline_precision, published_at, eligibility_scope,
          eligible_countries, link_ok)
       VALUES ($1,$2,$3,(SELECT id FROM categories WHERE code='grant'),$4,'published','verified',
               now(),'free',$5, now() + make_interval(days => $6), 'date_only', now(),
               'country_list', ARRAY['ZW']::char(2)[], true)`,
      [
        id,
        `window-fx-${id.slice(0, 12)}`,
        `Window fixture opportunity ${i + 1}`,
        orgId,
        `https://window.example/${id.slice(0, 8)}`,
        i + 2,
      ],
    );
    await client.query(
      `INSERT INTO eligibility_rules (opportunity_id, rule_type, params, source_quote, confidence)
       VALUES ($1,'country_in','{"countries":["ZW"]}','Open to residents of Zimbabwe.',0.95)`,
      [id],
    );
    await client.query(
      `INSERT INTO user_recommendations (user_id, opportunity_id, score, rank, reasons)
       VALUES ($1,$2,$3,$4,$5)`,
      [userId, id, 0.9 - i * 0.01, i + 1, ["Zimbabwe eligible", `closes in ${i + 2} days`]],
    );
  }
}, 60_000);

afterAll(async () => {
  if (!client) return;
  await actAs(null);
  await client.query("DELETE FROM user_recommendations WHERE user_id IN ($1,$2)", [userId, otherUserId]);
  await client.query("DELETE FROM opportunities WHERE organisation_id = $1", [orgId]);
  await client.query("DELETE FROM organisations WHERE id = $1", [orgId]);
  await client.query("DELETE FROM users WHERE id IN ($1,$2)", [userId, otherUserId]);
  await client.end();
});

describe("your_window (§14.1)", () => {
  it("caps at 8, however many recommendations exist", async () => {
    await actAs(userId);
    const { rows } = await client.query("SELECT * FROM your_window($1,$2)", [userId, 8]);
    expect(rows).toHaveLength(8);
  });

  it("orders by urgency", async () => {
    await actAs(userId);
    const { rows } = await client.query("SELECT * FROM your_window($1,$2)", [userId, 8]);
    const deadlines = rows.map((r) => new Date(r.deadline_at).getTime());
    expect(deadlines).toEqual([...deadlines].sort((a, b) => a - b));
  });

  it("says where the items came from, so the page can label them honestly", async () => {
    await actAs(userId);
    const { rows } = await client.query("SELECT * FROM your_window($1,$2)", [userId, 8]);
    expect(rows[0]?.source).toBe("recommendations");
  });

  it("carries the reason for each item (§14.3 — templated, never generated)", async () => {
    await actAs(userId);
    const { rows } = await client.query("SELECT * FROM your_window($1,$2)", [userId, 8]);
    expect(rows[0]?.reasons).toContain("Zimbabwe eligible");
  });

  it("recomputes the verdict rather than trusting the nightly run", async () => {
    // A profile edited since the nightly pass must change what the reader is told. A
    // stale verdict is the one thing this product must not show.
    await actAs(userId);
    const before = await client.query("SELECT * FROM your_window($1,$2)", [userId, 8]);
    expect(before.rows[0]?.verdict).toBe("eligible");

    await actAs(null);
    await client.query(
      "UPDATE eligibility_profiles SET country_of_residence = 'KE' WHERE user_id = $1",
      [userId],
    );
    await actAs(userId);
    const after = await client.query("SELECT * FROM your_window($1,$2)", [userId, 8]);
    // Now not_eligible, so §14.1's "all eligible or likely_eligible" drops them all and
    // the honest country board takes over.
    expect(after.rows[0]?.source).toBe("country_board");

    await actAs(null);
    await client.query(
      "UPDATE eligibility_profiles SET country_of_residence = 'ZW' WHERE user_id = $1",
      [userId],
    );
  });

  it("falls back to the country board rather than returning nothing (§8 [PR])", async () => {
    await actAs(otherUserId);
    const { rows } = await client.query("SELECT * FROM your_window($1,$2)", [otherUserId, 8]);
    // This user has no recommendations at all.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.source).toBe("country_board");
  });

  it("REFUSES to return another user's window", async () => {
    // The authorisation that makes a SECURITY DEFINER function with a user id parameter
    // safe. Without it this is an oracle for anyone's eligibility profile.
    await actAs(otherUserId);
    const { rows } = await client.query("SELECT * FROM your_window($1,$2)", [userId, 8]);
    expect(rows).toEqual([]);
  });

  it("returns nothing to an anonymous caller", async () => {
    await actAs(null);
    const { rows } = await client.query("SELECT * FROM your_window($1,$2)", [userId, 8]);
    expect(rows).toEqual([]);
  });
});

describe("next_actions (§14.2)", () => {
  it("caps at 5", async () => {
    await actAs(userId);
    const { rows } = await client.query("SELECT * FROM next_actions_capped($1,$2)", [userId, 5]);
    expect(rows.length).toBeLessThanOrEqual(5);
  });

  it("gives every action a reason and exactly one link", async () => {
    // §14.2 `[PR]`: "Each item states the reason and links to one action. No motivational
    // filler."
    await actAs(userId);
    const { rows } = await client.query("SELECT * FROM next_actions_capped($1,$2)", [userId, 5]);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(String(row.reason).length).toBeGreaterThan(10);
      expect(String(row.href)).toMatch(/^\//);
      expect(String(row.headline).length).toBeGreaterThan(5);
    }
  });

  it("tells a user with nothing tracked to save something", async () => {
    await actAs(userId);
    const { rows } = await client.query("SELECT * FROM next_actions_capped($1,$2)", [userId, 5]);
    expect(rows.map((r) => r.kind)).toContain("save_something");
  });

  it("surfaces a tracked item closing within five days, with the day count", async () => {
    await actAs(null);
    await client.query(
      `INSERT INTO tracker_entries (user_id, opportunity_id, state) VALUES ($1,$2,'planning_to_apply')`,
      [userId, oppIds[0]],
    );
    await actAs(userId);
    const { rows } = await client.query("SELECT * FROM next_actions_capped($1,$2)", [userId, 5]);
    const action = rows.find((r) => r.kind === "tracked_closing");
    expect(action).toBeDefined();
    // A number the reader can check, not "act soon".
    expect(String(action?.reason)).toMatch(/closes in \d+ day/);
  });

  it("nudges towards Telegram once something is tracked, with a count", async () => {
    // NOTIFICATIONS.md §4: "Telegram adoption is not a nice-to-have; it is the scaling
    // plan." This is the action that fixes the binding constraint.
    await actAs(userId);
    const { rows } = await client.query("SELECT * FROM next_actions_capped($1,$2)", [userId, 5]);
    const action = rows.find((r) => r.kind === "link_telegram");
    expect(action).toBeDefined();
    expect(String(action?.reason)).toMatch(/tracking \d+ thing/);
  });

  it("names a NUMBER when asking for a profile field", async () => {
    // §14.2's own example: "complete your student status — it will resolve eligibility on
    // 12 opportunities". Checkable, unlike "complete your profile".
    await actAs(null);
    await client.query("UPDATE eligibility_profiles SET student_status = NULL WHERE user_id = $1", [
      userId,
    ]);
    // Enough rules of that type to clear §14.2's threshold of 5.
    for (const id of oppIds.slice(0, 6)) {
      await client.query(
        `INSERT INTO eligibility_rules (opportunity_id, rule_type, params, source_quote, confidence)
         VALUES ($1,'student_status_in','{"statuses":["undergraduate"]}','Open to undergraduate students.',0.9)`,
        [id],
      );
    }
    await actAs(userId);
    const { rows } = await client.query("SELECT * FROM next_actions($1,$2)", [userId, 10]);
    const action = rows.find((r) => r.kind === "profile_student_status");
    expect(action).toBeDefined();
    expect(String(action?.reason)).toMatch(/resolves eligibility on \d+ opportunit/);
  });

  it("REFUSES another user's action list", async () => {
    await actAs(otherUserId);
    const { rows } = await client.query("SELECT * FROM next_actions_capped($1,$2)", [userId, 5]);
    expect(rows).toEqual([]);
  });

  it("contains no motivational filler", async () => {
    // §14.2 `[PR]` says so outright. Every reason should be a fact about the reader's own
    // state, and these are the words that show it is not.
    await actAs(userId);
    const { rows } = await client.query("SELECT * FROM next_actions_capped($1,$2)", [userId, 5]);
    const text = rows.map((r) => `${r.headline} ${r.reason}`).join(" ").toLowerCase();
    for (const filler of ["keep it up", "you're doing great", "don't miss out", "amazing", "exciting"]) {
      expect(text).not.toContain(filler);
    }
  });
});
