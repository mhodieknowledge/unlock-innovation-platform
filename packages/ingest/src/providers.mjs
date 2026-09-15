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
 * `permanent` marks a failure that cannot come right by asking again — a missing or
 * revoked key, or a model that has been retired or moved behind a tier this account
 * does not hold. The caller stops using that provider for the run.
 *
 * @returns {Promise<{ ok: true, data: unknown, call: Call }
 *                 | { ok: false, call: Call, permanent?: boolean, transient?: boolean,
 *                     retryAfterMs?: number }>}
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
      return {
        ok: false,
        // 503 is the service saying it is busy, not the account saying it is out.
        // Gemini's is "This model is currently experiencing high demand. Spikes in
        // demand are usually temporary. Please try again later." — an invitation to
        // retry, which §3.2 never asked us to treat as a breaker: it names "429 or
        // timing out", and 503 is neither. Lumping them together took the primary
        // extraction provider out for a whole run over a spike that had passed by the
        // next document.
        transient: response.status === 503,
        // How long the provider itself asked us to wait. Groq answers a TPM overage
        // with "Please try again in 37.5ms" and Gemini with a retryDelay; taking that
        // at its word is the difference between skipping a beat and sitting out the
        // rest of the run.
        retryAfterMs: retryHintMs(response.headers, detail) ?? undefined,
        call: call({ outcome: "rate_limited", detail: detail.slice(0, 300) }),
      };
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return {
        ok: false,
        // 401, 402, 403 and 404 are the configuration answering, not the service: a
        // missing key, a revoked key, an unpaid account, a model that has been retired
        // or moved behind a tier this account does not have. None of those come right
        // if we ask again, and asking again is what we were doing — the 13:53 run met
        // three retired models and paid 404s for every one of them on every document,
        // three calls apiece, because the breaker only ever tripped on 429.
        //
        // 402 earns its place here from the 14:22 run, where Cerebras answered every
        // single document with "Payment required to access this resource. Visit your
        // billing tab." A billing state does not change between two documents fetched
        // four seconds apart.
        permanent: [401, 402, 403, 404].includes(response.status),
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
      // §3.2 treats a timeout the same as a 429 — "both mean back off" — and a
      // fifteen-minute breaker is too blunt an instrument for it. On 2026-09-15 18:38
      // Gemini timed out on the FIRST document of the run. Every line after it reads
      // "gemini: skipped, breaker open", the whole registry fell through to a Groq
      // capped at 8,000 tokens a minute, and six sources that had fetched perfectly well
      // — Mastercard, Injini, Africa's Business Heroes, Tony Elumelu, Zindi, MEST — were
      // never given a model at all. One slow request cost the run its primary provider
      // and half its sources.
      //
      // So a timeout is transient like a 503: asked again, twice, and only if it is
      // still timing out does the chain step around it, with the breaker left closed.
      // A provider that was slow once is not a provider that is down.
      transient: aborted,
      call: call({
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
 * A short, safe description of a reply that was not what we asked for. Keys rather than
 * values: this is model output about a fetched page, and a log line is not the place to
 * reproduce it at length.
 *
 * @param {unknown} data
 */
function describeShape(data) {
  if (data === null || data === undefined) return "null";
  if (Array.isArray(data)) return `an array of ${data.length}`;
  if (typeof data !== "object") return `a ${typeof data}`;
  const keys = Object.keys(/** @type {Record<string, unknown>} */ (data));
  return keys.length === 0 ? "an empty object" : `keys: ${keys.slice(0, 8).join(", ")}`;
}

/** Never come back sooner than this, however eager the provider says we may be. */
const MIN_BACKOFF_MS = 1_000;

/**
 * How many times a busy provider is asked again before the chain moves on, and how long
 * it is given to stop being busy. Small on purpose: two extra attempts at a second and
 * two seconds costs three seconds on a document that was going to fail anyway, and
 * saves the run when the spike is the momentary kind the provider says it is.
 */
const TRANSIENT_RETRIES = 2;
const TRANSIENT_BACKOFF_MS = 1_000;

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The wait a provider asked for, in milliseconds, or null if it did not say.
 *
 * Three shapes, because three providers: the Retry-After header (seconds, per RFC
 * 9110), Groq's prose "Please try again in 37.5ms" or "in 2.5s", and Gemini's
 * structured `retryDelay: "13s"`. Clamped at both ends — a floor so a provider cannot
 * talk us into hammering it, and the §3.2 ceiling so a provider asking for an hour
 * still gets revisited within one.
 *
 * @param {Headers} headers
 * @param {string} body
 * @returns {number | null}
 */
function retryHintMs(headers, body) {
  // Number(null) is 0, not NaN, so an ABSENT header would read as "come back
  // immediately" and clamp to the floor — turning every hintless 429 into a one-second
  // pause instead of §3.2's fifteen minutes. The null check is the whole guard.
  const raw = headers?.get?.("retry-after");
  if (raw !== null && raw !== undefined && raw !== "") {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return clampBackoff(seconds * 1000);
  }

  // "try again in 37.5ms" / "try again in 2.5s" / "retryDelay": "13s"
  const prose = /(?:try again in|retryDelay"?\s*:\s*")\s*([\d.]+)\s*(ms|s)?/i.exec(body);
  if (prose?.[1]) {
    const value = Number(prose[1]);
    if (Number.isFinite(value)) {
      return clampBackoff(prose[2]?.toLowerCase() === "ms" ? value : value * 1000);
    }
  }
  return null;
}

/** @param {number} ms */
function clampBackoff(ms) {
  return Math.min(BREAKER_MS, Math.max(MIN_BACKOFF_MS, Math.round(ms)));
}

/**
 * Why a reply cannot be used, or null if it can.
 *
 * Two different failures wear one name in AI_SYSTEM.md §2 guardrail 2, and both are
 * "schema-invalid": a reply with no JSON in it at all (callProvider has already
 * labelled that one), and a reply that parsed cleanly but is not the thing we asked
 * for. Collapsing them here is what lets one repair path serve both.
 *
 * @param {{ok: boolean, data?: unknown, call: Call}} attempt
 * @param {((data: unknown) => boolean) | undefined} accept
 * @returns {string | null}
 */
function shapeRejection(attempt, accept) {
  if (!attempt.ok) {
    return attempt.call.outcome === "schema_invalid"
      ? (attempt.call.detail ?? "no JSON in the reply")
      : null;
  }
  if (accept && !accept(attempt.data)) {
    return `failed the shape check: ${describeShape(attempt.data)}`;
  }
  return null;
}

/**
 * The repair prompt §2 guardrail 2 has always promised and never had.
 *
 * "Output failing JSON-schema validation is discarded and retried once with a repair
 * prompt, then routed to human review." Only the discard was implemented: a reply that
 * parsed but came back as `keys: summary, deadline, cost` fell straight through to the
 * next provider, and when that was the last one the document failed extraction and
 * waited for a person. Eight documents in one run died that way, all of them from
 * pages that had been fetched successfully and read correctly — the model simply
 * answered in a shape nobody asked for.
 *
 * The retry costs one call, and it is the cheapest call in the pipeline: the document
 * is already fetched, the provider is already warm, and the alternative is re-fetching
 * and re-asking on the next run for the same answer. It is deliberately NOT a second
 * chance at the task — the instructions are unchanged and the page is unchanged. It
 * tells the model what came back and what was required, which is the one thing it
 * could not know.
 *
 * @param {string} user       the original user message, already truncated
 * @param {string} rejection  what was wrong, in the terms the log uses
 * @param {string} [shapeHint] what the caller actually wants, e.g. `with a "title"`
 * @returns {string}
 */
function repairUser(user, rejection, shapeHint) {
  return [
    user,
    "",
    "---",
    `Your previous reply to this exact request was rejected: ${rejection}.`,
    shapeHint
      ? `Reply with ONLY a JSON object ${shapeHint}.`
      : "Reply with ONLY the JSON object the instructions above describe.",
    "No prose, no explanation and no markdown fence: the first character must be { and the last must be }.",
  ].join("\n");
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
 * @param {string} [args.shapeHint]  what `accept` is looking for, in words, so the
 *   repair retry can say it. `accept` is a predicate and cannot describe itself.
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
      // Also said out loud. Without this, a run where every provider has tripped
      // reports "no provider configured" — which describes a chain that was never set
      // up, not one that was set up and failed, and sends the reader somewhere else.
      details.push(`${row.provider}: skipped, breaker open`);
      continue;
    }

    // A busy service gets asked again before the chain gives up on it. The free tiers
    // this project runs on answer 503 under load often enough that one refusal is not
    // evidence of anything, and the next provider down the chain is usually a worse
    // model or, on 2026-09-15, an unpaid account.
    let attempt = await callProvider(row, {
      system: args.system,
      user: args.user.slice(0, MAX_INPUT_CHARS),
      env: args.env,
      fetch: args.fetch,
      ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
    });
    calls.push(attempt.call);

    for (let retry = 1; retry <= TRANSIENT_RETRIES && !attempt.ok && attempt.transient; retry += 1) {
      await sleep(attempt.retryAfterMs ?? TRANSIENT_BACKOFF_MS * retry);
      attempt = await callProvider(row, {
        system: args.system,
        user: args.user.slice(0, MAX_INPUT_CHARS),
        env: args.env,
        fetch: args.fetch,
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
      });
      calls.push(attempt.call);
    }

    // §2 guardrail 2: schema-invalid output is "retried once with a repair prompt".
    // Once, on the provider that produced it — a model that answered in the wrong shape
    // has still read the page, and stepping to the next provider throws that reading
    // away to ask a weaker model the same question from scratch.
    //
    // Counted as schema-invalid either way, so §12's schema-valid rate measures the
    // model's first answer rather than our recovery from it. Carrying a slice of what
    // came back matters as much here as in the log: "failed the shape check" names the
    // test and withholds the evidence, and a refusal, a reasoning preamble and a renamed
    // field all read identically without it.
    const rejection = shapeRejection(attempt, args.accept);
    if (rejection !== null) {
      if (attempt.ok) {
        calls[calls.length - 1] = { ...attempt.call, outcome: "schema_invalid", detail: rejection };
      }

      const repaired = await callProvider(row, {
        system: args.system,
        user: repairUser(args.user.slice(0, MAX_INPUT_CHARS), rejection, args.shapeHint),
        env: args.env,
        fetch: args.fetch,
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
      });
      calls.push(repaired.call);

      const stillWrong = shapeRejection(repaired, args.accept);
      if (stillWrong !== null) {
        if (repaired.ok) {
          calls[calls.length - 1] = {
            ...repaired.call, outcome: "schema_invalid", detail: stillWrong,
          };
        }
        details.push(`${row.provider}: ${rejection}; repaired once and ${stillWrong}`);
        continue;
      }

      // The repair either worked or failed for a reason that has nothing to do with
      // shape — a 429, a timeout, an outage that arrived between the two calls. The
      // first case returns below; the second falls through to the breaker handling,
      // which is the only place that knows what to do with it.
      attempt = repaired;
    }

    if (attempt.ok) {
      return { ok: true, data: attempt.data, provider: row.provider, model: row.model, calls };
    }

    // A service that was busy every time we asked is worth stepping around for this
    // document, but not worth banning: the spike it reported is measured in seconds and
    // the breaker in minutes, so it is left open for the next document to try again.
    if (attempt.transient) {
      if (attempt.call.detail) details.push(`${row.provider}: ${attempt.call.detail}`);
      continue;
    }

    if (attempt.call.outcome === "rate_limited") {
      // §3.2 says a 429 trips a breaker for fifteen minutes. That is the right default
      // for a provider that will not say when to come back, and the wrong answer when
      // it does: on 2026-09-15 Groq reported a token-per-minute overage of five tokens
      // — "Limit 8000, Used 4281, Requested 3724. Please try again in 37.5ms" — and the
      // flat fifteen minutes took it out of the chain for the whole run over a gap
      // shorter than a single request. The polite fetcher has honoured Retry-After
      // since it was written (§2.1 rule 4); this is the same courtesy, in the direction
      // that happens to be ours.
      breakers.trip(row.provider, attempt.retryAfterMs ?? BREAKER_MS);
    }
    // A misconfigured provider is out for the run, not for fifteen minutes — but the
    // breaker is the mechanism we have and a run is shorter than its window, so the
    // effect is the same and there is no second concept to maintain.
    if (attempt.permanent) breakers.trip(row.provider);
    if (attempt.call.detail) details.push(`${row.provider}: ${attempt.call.detail}`);
  }

  return {
    ok: false,
    reason: "NO_AI",
    calls,
    detail: details.length > 0 ? details.join(" | ").slice(0, 1000) : "no provider configured",
  };
}
