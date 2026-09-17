/**
 * The image route, which is the one endpoint in this app that makes our server fetch a URL
 * chosen by a third party.
 *
 * The obvious version of this endpoint — `/img?url=…` — is a server-side request forgery
 * primitive with a CDN in front of it. These tests are mostly about the ways this one refuses
 * to be that: the input is a SLUG, the URL comes from a published row, and the response is
 * checked before a byte of it reaches a reader.
 *
 * Every refusal is asserted to be a 404 rather than a 500. The card renders without a picture,
 * so "we could not get this" has a state the design already knows how to be — and a 500 would
 * make every broken third-party CDN look like our own outage.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  row: { image_url: "https://cdn.example.org/banner.jpg" } as { image_url: string | null } | null,
  /** What the route's own query was filtered by, so the published-only rule can be asserted. */
  filters: [] as { column: string; value: unknown }[],
};

vi.mock("~/lib/db", () => ({
  getClient: vi.fn(() => ({
    from: () => ({
      select: () => {
        const chain = {
          eq: (column: string, value: unknown) => {
            state.filters.push({ column, value });
            return chain;
          },
          is: (column: string, value: unknown) => {
            state.filters.push({ column, value });
            return chain;
          },
          maybeSingle: async () => ({ data: state.row, error: null }),
        };
        return chain;
      },
    }),
  })),
}));

vi.mock("~/lib/runtime", () => ({ runtimeEnv: () => ({}) }));

async function get(slug: string): Promise<Response> {
  const { GET } = await import("../src/pages/img/[slug]");
  return (await GET({
    params: { slug },
    request: new Request(`https://example.invalid/img/${slug}`),
  } as never)) as Response;
}

/** An upstream that answers with the given headers and body. */
function upstream(body: Uint8Array | string, headers: Record<string, string>, ok = true) {
  return vi.fn(async () =>
    new Response(typeof body === "string" ? body : (body.buffer as ArrayBuffer), {
      status: ok ? 200 : 502,
      headers,
    }),
  );
}

const JPEG = { "content-type": "image/jpeg" };
const bytes = (n: number) => new Uint8Array(n).fill(1);

beforeEach(() => {
  state.row = { image_url: "https://cdn.example.org/banner.jpg" };
  state.filters = [];
  vi.stubGlobal("fetch", upstream(bytes(2048), JPEG));
});

describe("what it will serve", () => {
  it("relays the picture the row points at", async () => {
    const res = await get("a-hackathon");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect((await res.arrayBuffer()).byteLength).toBe(2048);
  });

  it("asks only for a published, undeleted listing", async () => {
    // A picture belongs to a listing a reader may see. Without this the endpoint serves
    // banners for rows in review or soft-deleted — a hidden listing leaking by its artwork.
    await get("a-hackathon");
    expect(state.filters).toContainEqual({ column: "status", value: "published" });
    expect(state.filters).toContainEqual({ column: "deleted_at", value: null });
  });

  it("caches hard at the edge, and never sniffs", async () => {
    const res = await get("a-hackathon");
    const cache = res.headers.get("cache-control") ?? "";
    expect(cache).toContain("s-maxage=");
    // Relayed third-party bytes. Neither header is optional on a response we did not author.
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
  });
});

describe("what it refuses", () => {
  it("404s a listing with no picture, and one that does not exist", async () => {
    state.row = { image_url: null };
    expect((await get("no-picture")).status).toBe(404);
    state.row = null;
    expect((await get("not-a-listing")).status).toBe(404);
  });

  it("never fetches a stored URL that would not pass validation today", async () => {
    // The row was written by a pipeline that ran some other day, under rules that may since
    // have changed. The route re-validates rather than trusting the column.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    for (const bad of [
      "http://cdn.example.org/a.jpg",
      "https://127.0.0.1/a.jpg",
      "https://169.254.169.254/latest/meta-data/",
      "https://user:pw@cdn.example.org/a.jpg",
      "https://cdn.example.org:8080/a.jpg",
      "file:///etc/passwd",
    ]) {
      state.row = { image_url: bad };
      expect((await get("x")).status, bad).toBe(404);
    }
    expect(fetchSpy, "a refused URL must never be requested at all").not.toHaveBeenCalled();
  });

  it("refuses anything that is not an image we chose to relay", async () => {
    // An HTML error page served as an image is the classic way a proxy becomes an open
    // redirect for content. SVG is excluded on purpose: it is a script vector.
    for (const type of ["text/html", "application/json", "image/svg+xml", ""]) {
      vi.stubGlobal("fetch", upstream("<html>nope</html>", { "content-type": type }));
      expect((await get("x")).status, type || "(none)").toBe(404);
    }
  });

  it("refuses an upstream that failed", async () => {
    vi.stubGlobal("fetch", upstream(bytes(10), JPEG, false));
    expect((await get("x")).status).toBe(404);
  });

  it("refuses a picture that is too heavy, by its header or by its bytes", async () => {
    // Declared over the cap: refused without reading anything.
    vi.stubGlobal("fetch", upstream(bytes(16), { ...JPEG, "content-length": String(999 * 1024) }));
    expect((await get("x")).status).toBe(404);

    // A lying or absent content-length is caught by the counter, which is why both exist. A
    // reader paying by the megabyte must not be handed 400 KB because a CDN misreported.
    vi.stubGlobal("fetch", upstream(bytes(400 * 1024), JPEG));
    expect((await get("x")).status).toBe(404);
  });

  it("refuses rather than truncating, so a card never shows half a picture", async () => {
    vi.stubGlobal("fetch", upstream(bytes(121 * 1024), JPEG));
    const res = await get("x");
    expect(res.status).toBe(404);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it("404s when the upstream throws or times out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect((await get("x")).status).toBe(404);
  });

  it("rejects an absurd slug without touching the database", async () => {
    expect((await get("")).status).toBe(404);
    expect((await get("x".repeat(500))).status).toBe(404);
  });
});
