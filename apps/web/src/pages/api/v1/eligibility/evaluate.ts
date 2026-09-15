import type { APIRoute } from "astro";
import { z } from "zod";

import { evaluate, type EligibilityRule } from "@mbele/eligibility";
import { getClient } from "~/lib/db";
import { reportError } from "~/lib/errors";
import { runtimeEnv } from "~/lib/runtime";

/**
 * POST /api/v1/eligibility/evaluate — API_SPEC.md §3.
 *
 * Works logged out. Anonymous inputs are NEVER persisted (PRODUCT_SPEC.md §12.1,
 * DATA_MODEL.md §3, PRIVACY_AND_COMPLIANCE.md §2 control 6): they arrive in the
 * request body, are evaluated in memory, and are gone when the response is
 * written. Nothing is logged, nothing is stored, nothing is sent onward.
 *
 * Invariant 8 — never call an LLM in a request handler. This handler calls a
 * pure function. There is no network I/O in the evaluation path at all, which is
 * also why it can be fast enough to feel instant on a slow connection.
 *
 * Invariant 6 — no user personal data reaches any AI provider. The profile in
 * this body never leaves the process.
 */
export const prerender = false;

const ISO2 = z.string().length(2).regex(/^[A-Za-z]{2}$/);

const ProfileSchema = z
  .object({
    country_of_residence: ISO2.nullish(),
    nationalities: z.array(ISO2).max(5).nullish(),
    birth_year: z.number().int().min(1900).max(2100).nullish(),
    student_status: z
      .enum(["not_student", "secondary", "undergraduate", "postgraduate", "recent_graduate"])
      .nullish(),
    year_of_study: z.number().int().min(1).max(12).nullish(),
    institution_type: z
      .enum(["university", "polytechnic", "secondary", "bootcamp", "none"])
      .nullish(),
    years_experience: z.number().int().min(0).max(80).nullish(),
    languages: z.array(z.string().max(40)).max(10).nullish(),
    gender: z.string().max(40).nullish(),
    can_travel: z.boolean().nullish(),
    remote_only: z.boolean().nullish(),
  })
  .strict();

const BodySchema = z
  .object({
    // API_SPEC.md §3 caps this at 25 — enough for a list page, small enough that
    // the endpoint cannot be used to bulk-enumerate the catalogue.
    opportunity_ids: z.array(z.string().uuid()).min(1).max(25),
    profile: ProfileSchema,
  })
  .strict();

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // API_SPEC.md §1.4: eligibility evaluation is never cached. The verdict is
      // specific to the person asking.
      "cache-control": "private, no-store",
    },
  });

const error = (status: number, code: string, message: string, field?: string) =>
  json({ error: { code, message, ...(field ? { field } : {}) } }, status);

export const POST: APIRoute = async ({ request, locals }) => {
  const env = runtimeEnv();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return error(400, "VALIDATION_FAILED", "Body must be valid JSON.");
  }

  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return error(
      400,
      "ELIGIBILITY_INPUT_INVALID",
      first?.message ?? "Request body failed validation.",
      first?.path.join("."),
    );
  }

  const { opportunity_ids, profile } = parsed.data;

  const client = getClient(env);
  if (!client) {
    // Invariant 10 in spirit: a dependency being unavailable never produces a
    // 5xx on a user-facing read. Say plainly that certainty is reduced.
    return json(
      {
        data: {
          verdicts: opportunity_ids.map((id) => ({
            opportunity_id: id,
            verdict: "unclear",
            confidence: 0,
            rules: [],
            missing_fields: [],
            disclaimer: "Always confirm on the official page — rules change.",
          })),
        },
        meta: { degraded_features: ["eligibility_rules"] },
      },
      200,
    );
  }

  try {
    const { data: ruleRows, error: dbError } = await client
      .from("eligibility_rules")
      .select("opportunity_id, rule_type, params, source_quote, confidence")
      .in("opportunity_id", opportunity_ids);

    if (dbError) throw new Error(dbError.message);

    const byOpportunity = new Map<string, EligibilityRule[]>();
    for (const id of opportunity_ids) byOpportunity.set(id, []);
    for (const row of (ruleRows ?? []) as unknown as (EligibilityRule & {
      opportunity_id: string;
    })[]) {
      byOpportunity.get(row.opportunity_id)?.push({
        rule_type: row.rule_type,
        params: row.params,
        source_quote: row.source_quote,
        confidence: Number(row.confidence),
      });
    }

    const verdicts = opportunity_ids.map((id) => {
      const result = evaluate(byOpportunity.get(id) ?? [], profile);
      return {
        opportunity_id: id,
        verdict: result.verdict,
        confidence: result.confidence,
        // Every rule carries its source quote. API_SPEC.md §3 states the
        // invariant plainly: a response where a pass/fail rule lacks one is a
        // bug, not a degraded mode.
        rules: result.rule_results.map((r) => ({
          type: r.rule_type,
          outcome: r.outcome,
          confidence: r.confidence,
          source_quote: r.source_quote,
          explanation: r.explanation,
          ...(r.resolves_with.length > 0 ? { resolves_with: r.resolves_with } : {}),
        })),
        missing_fields: result.missing_fields,
        disclaimer: result.disclaimer,
      };
    });

    return json({ data: { verdicts }, meta: { degraded_features: [] } });
  } catch (err) {
    await reportError(err, { route: "/api/v1/eligibility/evaluate" }, env);
    return error(503, "DEGRADED", "We couldn't check eligibility just now. Try again shortly.");
  }
};
