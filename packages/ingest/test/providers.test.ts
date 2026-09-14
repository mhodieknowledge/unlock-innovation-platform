/**
 * The provider layer. AI_SYSTEM.md §3 and §13's failure matrix.
 *
 * The property under test is the one §13 states as the design target: "Nothing in
 * this matrix takes the product offline, and nothing in it causes an untrue
 * statement to be shown." So every failure mode below has to come back as an
 * ordinary NO_AI value that a caller cannot forget to handle — never a throw, never
 * a half-parsed record.
 */

import { describe, expect, it, vi } from "vitest";

import { Breakers, parseJsonLoose, runTask } from "../src/providers.mjs";

const CHAIN = [
  { provider: "groq", model: "a-small-model", endpoint: "https://groq.invalid/v1/chat", api_key_env: "GROQ_API_KEY" },
  { provider: "cerebras", model: "another-model", endpoint: "https://cerebras.invalid/v1/chat", api_key_env: "CEREBRAS_API_KEY" },
];

const ENV = { GROQ_API_KEY: "k1", CEREBRAS_API_KEY: "k2" };

const openAiReply = (content: string, usage = { prompt_tokens: 100, completion_tokens: 20 }) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("parseJsonLoose", () => {
  it("reads bare JSON", () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });

  it("reads JSON out of a code fence", () => {
    // Models wrap JSON in fences however firmly they are told not to, and a correct
    // object in a fence is badly packaged rather than invalid — discarding it would
    // spend a second call for nothing.
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose("```\n[1,2]\n```")).toEqual([1, 2]);
  });

  it("reads JSON out of surrounding prose", () => {
    expect(parseJsonLoose('Sure! Here is the record:\n{"a":1}\nLet me know if you need more.')).toEqual(
      { a: 1 },
    );
  });

  it("is not confused by braces inside strings", () => {
    expect(parseJsonLoose('{"note":"a } brace"}')).toEqual({ note: "a } brace" });
    expect(parseJsonLoose('{"note":"an escaped \\" quote and a }"}')).toEqual({
      note: 'an escaped " quote and a }',
    });
  });

  it("returns null rather than a guess when there is no JSON", () => {
    expect(parseJsonLoose("I cannot help with that request.")).toBeNull();
    expect(parseJsonLoose("")).toBeNull();
    expect(parseJsonLoose("{unterminated")).toBeNull();
  });
});

describe("runTask", () => {
  it("returns the first provider's answer and stops", async () => {
    const fetchMock = vi.fn(async () => openAiReply('{"title":"A grant"}'));
    const result = await runTask({
      chain: CHAIN,
      system: "s",
      user: "u",
      env: ENV,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ title: "A grant" });
      expect(result.provider).toBe("groq");
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]?.tokens_in).toBe(100);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls through to the next provider on a 429 and trips the breaker", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(openAiReply('{"title":"A grant"}'));

    const breakers = new Breakers();
    const result = await runTask({
      chain: CHAIN,
      system: "s",
      user: "u",
      env: ENV,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      breakers,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.provider).toBe("cerebras");
    // §3.2: 15 minutes, so the rest of the run does not keep asking.
    expect(breakers.isOpen("groq")).toBe(true);
    expect(breakers.isOpen("cerebras")).toBe(false);
  });

  it("skips a provider whose breaker is already open, without calling it", async () => {
    const fetchMock = vi.fn(async () => openAiReply('{"ok":true}'));
    const breakers = new Breakers();
    breakers.trip("groq");

    const result = await runTask({
      chain: CHAIN,
      system: "s",
      user: "u",
      env: ENV,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      breakers,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    if (result.ok) expect(result.provider).toBe("cerebras");
    expect(result.calls[0]?.outcome).toBe("breaker_open");
  });

  it("lets a breaker expire", () => {
    let now = 1_000_000;
    const breakers = new Breakers(() => now);
    breakers.trip("groq", 1000);
    expect(breakers.isOpen("groq")).toBe(true);
    now += 1001;
    expect(breakers.isOpen("groq")).toBe(false);
  });

  it("treats a timeout like a 429 — both mean back off", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init: unknown) => {
      const signal = (init as { signal?: AbortSignal }).signal;
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const result = await runTask({
      chain: [CHAIN[0]!],
      system: "s",
      user: "u",
      env: ENV,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      timeoutMs: 10,
    });

    expect(result.ok).toBe(false);
    expect(result.calls[0]?.outcome).toBe("rate_limited");
    expect(result.calls[0]?.detail).toBe("timed out");
  });

  it("returns NO_AI when every provider fails — never a throw", async () => {
    // §13: "All providers down -> Search still works; no new opportunities publish."
    // That is only reachable if exhaustion is an ordinary value.
    const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }));
    const result = await runTask({
      chain: CHAIN,
      system: "s",
      user: "u",
      env: ENV,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("NO_AI");
      expect(result.detail).toContain("500");
      // Every attempt is reported, so ai_usage records the whole failed chain.
      expect(result.calls).toHaveLength(2);
    }
  });

  it("returns NO_AI when a network error is thrown rather than returned", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const result = await runTask({
      chain: [CHAIN[0]!],
      system: "s",
      user: "u",
      env: ENV,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.calls[0]?.detail).toContain("fetch failed");
  });

  it("skips a provider whose key is not configured, and says so", async () => {
    const fetchMock = vi.fn(async () => openAiReply('{"ok":true}'));
    const result = await runTask({
      chain: CHAIN,
      system: "s",
      user: "u",
      env: { CEREBRAS_API_KEY: "k2" },
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    if (result.ok) expect(result.provider).toBe("cerebras");
    expect(result.calls[0]?.outcome).toBe("no_ai");
    expect(result.calls[0]?.detail).toContain("GROQ_API_KEY");
  });

  it("counts an unparseable reply as schema-invalid and moves on", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(openAiReply("I'm sorry, I can't do that."))
      .mockResolvedValueOnce(openAiReply('{"title":"A grant"}'));

    const result = await runTask({
      chain: CHAIN,
      system: "s",
      user: "u",
      env: ENV,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    expect(result.calls[0]?.outcome).toBe("schema_invalid");
    expect(result.ok).toBe(true);
  });

  it("rejects a well-formed reply that is the wrong shape", async () => {
    // A model that returns {"error":"..."} has answered successfully and said
    // nothing useful. Accepting it would put junk into the pipeline.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(openAiReply('{"error":"cannot comply"}'))
      .mockResolvedValueOnce(openAiReply('{"title":"A grant"}'));

    const result = await runTask({
      chain: CHAIN,
      system: "s",
      user: "u",
      env: ENV,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      accept: (data) => typeof data === "object" && data !== null && "title" in data,
    });

    expect(result.calls[0]?.outcome).toBe("schema_invalid");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.provider).toBe("cerebras");
  });

  it("returns NO_AI for an empty chain rather than pretending", async () => {
    const result = await runTask({
      chain: [],
      system: "s",
      user: "u",
      env: ENV,
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toBe("no provider configured");
  });

  it("truncates the input, because §11 lists that as a cost control", async () => {
    let sentLength = 0;
    const fetchMock = vi.fn(async (_url: unknown, init: unknown) => {
      const body = JSON.parse(String((init as { body: string }).body));
      sentLength = body.messages[1].content.length;
      return openAiReply('{"ok":true}');
    });

    await runTask({
      chain: [CHAIN[0]!],
      system: "s",
      user: "x".repeat(100_000),
      env: ENV,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    expect(sentLength).toBeLessThanOrEqual(24_000);
  });

  it("sends temperature 0, because extraction is not a creative task", async () => {
    // A record that changes between runs makes change detection meaningless: every
    // re-verification would look like the source had changed.
    let sentTemperature: unknown;
    const fetchMock = vi.fn(async (_url: unknown, init: unknown) => {
      sentTemperature = JSON.parse(String((init as { body: string }).body)).temperature;
      return openAiReply('{"ok":true}');
    });

    await runTask({
      chain: [CHAIN[0]!],
      system: "s",
      user: "u",
      env: ENV,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    expect(sentTemperature).toBe(0);
  });

  it("reads Gemini's reply shape as well as the OpenAI one", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"title":"A grant"}' }] } }],
          usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 40 },
        }),
        { status: 200 },
      ),
    );

    const result = await runTask({
      chain: [
        {
          provider: "gemini",
          model: "a-flash-model",
          endpoint: "https://gemini.invalid/v1beta/models",
          api_key_env: "GEMINI_API_KEY",
        },
      ],
      system: "s",
      user: "u",
      env: { GEMINI_API_KEY: "k" },
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ title: "A grant" });
      expect(result.calls[0]?.tokens_in).toBe(500);
      expect(result.calls[0]?.tokens_out).toBe(40);
    }
  });

  it("never puts an API key in a URL we log or in a call record", async () => {
    const fetchMock = vi.fn(async () => openAiReply('{"ok":true}'));
    const result = await runTask({
      chain: [CHAIN[0]!],
      system: "s",
      user: "u",
      env: ENV,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    // Invariant 11's spirit: the call record is written to ai_usage, so it must not
    // be able to carry a secret into the database.
    expect(JSON.stringify(result.calls)).not.toContain("k1");
  });
});
