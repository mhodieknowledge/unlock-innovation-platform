/**
 * The provider layer. AI_SYSTEM.md §3.
 *
 * Three properties this module exists to guarantee:
 *
 *   1. §2 guardrail 7 `[PR]`: "Every caller handles NO_AI. The provider interface
 *      returns a discriminated union, so the compiler enforces it." Every function
 *      here returns `{ ok: true, ... }` or `{ ok: false, reason: "NO_AI", ... }` and
 *      never throws for an ordinary failure — a caller cannot forget the failure
 *      path if the success path is only reachable through a check.
 *
 *   2. §2 guardrail 6 `[PR]`: no model name appears here. The chain is passed in,
 *      read from ai_providers.
 *
 *   3. §3.2: a provider returning 429 or timing out trips a breaker for 15 minutes,
 *      and the chain falls through to the next one. All consumption is reported to
 *      the caller for logging to ai_usage.
 *
 * `fetch` is injected so this is testable without a network, and so the same code
 * runs under Node in the batch tier and in a Worker at the edge.
 */

/** §3.2: "A provider returning 429 or timing out trips a breaker for 15 minutes." */
export const BREAKER_MS = 15 * 60 * 1000;

/** §4: strict input truncation is one of §11's named cost controls. */
export const MAX_INPUT_CHARS = 24_000;

/**
 * @typedef {object} ProviderRow
 * @property {string} provider
 * @property {string} model
 * @property {string | null} [endpoint]
 * @property {string | null} [api_key_env]
 * @property {number} [priority]
 * @property {number | null} [requests_per_minute]
 */

/**
 * @typedef {object} Call
 * @property {string} provider
 * @property {string} model
 * @property {number} tokens_in
 * @property {number} tokens_out
 * @property {number} latency_ms
 * @property {"ok"|"schema_invalid"|"rate_limited"|"error"|"breaker_open"|"no_ai"} outcome
 * @property {string} [detail]
 */

/**
 * @typedef {{ ok: true, data: unknown, provider: string, model: string, calls: Call[] }
 *         | { ok: false, reason: "NO_AI", calls: Call[], detail: string }} AiResult
 */

/**
 * Circuit breakers, held in memory.
 *
 * In-process is the right scope for the batch tier: each job is one process, and a
 * provider that 429s at the start of a run should be skipped for the rest of that
 * run. §3.2 also specifies a KV-persisted accountant for the edge; the durable
 * half of the accounting is ai_usage, which ai_chain_for reads to enforce the daily
 * ceiling across runs. This class is the fast, local half.
 */
export class Breakers {
  constructor(now = () => Date.now()) {
    /** @type {Map<string, number>} */
    this.openUntil = new Map();
    this.now = now;
  }

  /** @param {string} provider */
  isOpen(provider) {
    const until = this.openUntil.get(provider);
    if (until === undefined) return false;
    if (until <= this.now()) {
      this.openUntil.delete(provider);
      return false;
    }
    return true;
  }

  /** @param {string} provider @param {number} [ms] */
  trip(provider, ms = BREAKER_MS) {
    this.openUntil.set(provider, this.now() + ms);
  }
}

/**
 * Extract the first JSON value from a model's reply.
 *
 * Models wrap JSON in prose and fences however firmly they are told not to.
 * §2 guardrail 2 says schema-invalid output is discarded and retried once — but a
 * correct object inside a code fence is not schema-invalid, it is badly packaged, and
 * discarding it would spend a second call for no reason.
 *
 * @param {string} text
 * @returns {unknown}
 */
export function parseJsonLoose(text) {
  const s = String(text ?? "").trim();
  if (!s) return null;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  const candidates = [fenced?.[1], s].filter((c) => typeof c === "string");

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Fall through to bracket matching.
    }
    // The outermost {...} or [...]; a model's trailing "Let me know if..." is common.
    const start = candidate.search(/[[{]/);
    if (start === -1) continue;
    const opener = candidate[start];
    const closer = opener === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < candidate.length; i += 1) {
      const ch = candidate[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === opener) depth += 1;
      else if (ch === closer) {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(candidate.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

/**
 * One provider call, normalised across the OpenAI-compatible and Gemini shapes.
 *
 * @param {ProviderRow} row
 * @param {object} args
 * @param {string} args.system
 * @param {string} args.user
 * @param {Record<string, string | undefined>} args.env
 * @param {typeof globalThis.fetch} args.fetch
 * @param {number} [args.timeoutMs]
 * @returns {Promise<{ ok: true, data: unknown, call: Call } | { ok: false, call: Call }>}
 */
export async function callProvider(row, args) {
  const started = Date.now();
  const base = {
    provider: row.provider,
    model: row.model,
    tokens_in: 0,
    tokens_out: 0,
    latency_ms: 0,
  };
  /** @param {Partial<Call>} extra @returns {Call} */
  const call = (extra) => ({
    ...base,
    latency_ms: Date.now() - started,
    outcome: "error",
    ...extra,
  });

  const key = row.api_key_env ? args.env[row.api_key_env] : undefined;
  if (row.api_key_env && !key) {
    // Not an error worth retrying, and not a reason to stop: an unconfigured
    // provider is simply not in the chain for this deployment.
    return { ok: false, call: call({ outcome: "no_ai", detail: `${row.api_key_env} is not set` }) };
  }
  if (!row.endpoint) {
    return { ok: false, call: call({ outcome: "no_ai", detail: "no endpoint configured" }) };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? 30_000);

  try {
    const isGemini = row.provider === "gemini";
    const url = isGemini
      ? `${row.endpoint}/${row.model}:generateContent?key=${encodeURIComponent(key ?? "")}`
      : row.endpoint;

    /** @type {Record<string, string>} */
    const headers = { "content-type": "application/json" };
    if (!isGemini && key) headers["authorization"] = `Bearer ${key}`;

    const body = isGemini
      ? {
          systemInstruction: { parts: [{ text: args.system }] },
          contents: [{ role: "user", parts: [{ text: args.user }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        }
      : {
          model: row.model,
          // Temperature 0 everywhere. Extraction is not a creative task, and a
          // record that changes between runs makes change detection meaningless.
          temperature: 0,
          messages: [
            { role: "system", content: args.system },
            { role: "user", content: args.user },
          ],
          response_format: { type: "json_object" },
        };

    const response = await args.fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (response.status === 429 || response.status === 503) {
      const detail = await response.text().catch(() => "");
      return { ok: false, call: call({ outcome: "rate_limited", detail: detail.slice(0, 300) }) };
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return {
        ok: false,
        call: call({ outcome: "error", detail: `${response.status} ${detail.slice(0, 300)}` }),
      };
    }

    const payload = /** @type {Record<string, unknown>} */ (await response.json());
    const text = isGemini ? geminiText(payload) : openAiText(payload);
    const usage = usageFrom(payload);
    const data = parseJsonLoose(text ?? "");

    if (data === null) {
      // §2 guardrail 2: schema-invalid output is discarded. The retry is the
      // caller's, once, with a repair prompt.
      return {
        ok: false,
        call: call({
          outcome: "schema_invalid",
          tokens_in: usage.in,
          tokens_out: usage.out,
          detail: `no JSON in reply: ${String(text ?? "").slice(0, 200)}`,
        }),
      };
    }

    return {
      ok: true,
      data,
      call: call({ outcome: "ok", tokens_in: usage.in, tokens_out: usage.out }),
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      call: call({
        // §3.2 treats a timeout the same as a 429: both mean back off.
        outcome: aborted ? "rate_limited" : "error",
        detail: aborted ? "timed out" : String(err instanceof Error ? err.message : err).slice(0, 300),
      }),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** @param {Record<string, unknown>} payload */
function openAiText(payload) {
  const choices = payload["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = /** @type {Record<string, unknown>} */ (choices[0])?.["message"];
  if (typeof message !== "object" || message === null) return null;
  const content = /** @type {Record<string, unknown>} */ (message)["content"];
  return typeof content === "string" ? content : null;
}

/** @param {Record<string, unknown>} payload */
function geminiText(payload) {
  const candidates = payload["candidates"];
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const content = /** @type {Record<string, unknown>} */ (candidates[0])?.["content"];
  if (typeof content !== "object" || content === null) return null;
  const parts = /** @type {Record<string, unknown>} */ (content)["parts"];
  if (!Array.isArray(parts)) return null;
  return parts
    .map((p) => (typeof p === "object" && p !== null ? /** @type {Record<string, unknown>} */ (p)["text"] : null))
    .filter((t) => typeof t === "string")
    .join("");
}

/** @param {Record<string, unknown>} payload */
function usageFrom(payload) {
  const usage = payload["usage"] ?? payload["usageMetadata"];
  if (typeof usage !== "object" || usage === null) return { in: 0, out: 0 };
  const u = /** @type {Record<string, unknown>} */ (usage);
  /** @param {unknown} v */
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    in: num(u["prompt_tokens"] ?? u["promptTokenCount"]),
    out: num(u["completion_tokens"] ?? u["candidatesTokenCount"]),
  };
}

/**
 * Run a task down its chain until one provider answers, then stop.
 *
 * Returns NO_AI rather than throwing when the chain is exhausted — §13's failure
 * matrix requires that "all providers down" means "no new opportunities publish",
 * not an outage, and the only way to guarantee that at every call site is for the
 * failure to be an ordinary value.
 *
 * @param {object} args
 * @param {ProviderRow[]} args.chain     from ai_chain_for, best first
 * @param {string} args.system
 * @param {string} args.user
 * @param {Record<string, string | undefined>} args.env
 * @param {typeof globalThis.fetch} args.fetch
 * @param {Breakers} [args.breakers]
 * @param {(data: unknown) => boolean} [args.accept]  reject a well-formed reply that
 *   is not what was asked for, so the chain falls through instead of returning junk
 * @param {number} [args.timeoutMs]
 * @returns {Promise<AiResult>}
 */
export async function runTask(args) {
  const breakers = args.breakers ?? new Breakers();
  /** @type {Call[]} */
  const calls = [];
  const details = [];

  for (const row of args.chain) {
    if (breakers.isOpen(row.provider)) {
      calls.push({
        provider: row.provider,
        model: row.model,
        tokens_in: 0,
        tokens_out: 0,
        latency_ms: 0,
        outcome: "breaker_open",
        detail: "skipped: breaker open",
      });
      continue;
    }

    const attempt = await callProvider(row, {
      system: args.system,
      user: args.user.slice(0, MAX_INPUT_CHARS),
      env: args.env,
      fetch: args.fetch,
      ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
    });
    calls.push(attempt.call);

    if (attempt.ok) {
      if (args.accept && !args.accept(attempt.data)) {
        // A reply that parsed but is not the right shape. Counted as schema-invalid
        // so the metric in §12 ("schema-valid rate") reflects reality.
        calls[calls.length - 1] = { ...attempt.call, outcome: "schema_invalid", detail: "failed the shape check" };
        details.push(`${row.provider}: reply failed the shape check`);
        continue;
      }
      return { ok: true, data: attempt.data, provider: row.provider, model: row.model, calls };
    }

    if (attempt.call.outcome === "rate_limited") breakers.trip(row.provider);
    if (attempt.call.detail) details.push(`${row.provider}: ${attempt.call.detail}`);
  }

  return {
    ok: false,
    reason: "NO_AI",
    calls,
    detail: details.length > 0 ? details.join(" | ").slice(0, 1000) : "no provider configured",
  };
}
