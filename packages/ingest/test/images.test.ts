/**
 * The image a source publishes about itself.
 *
 * Two jobs, and the second is the one with teeth. Finding `og:image` is parsing. Deciding
 * that our own server may fetch it is a security decision, because everything this module
 * returns is later requested server-side — so the cases below are mostly the ones where the
 * right answer is null.
 */

import { describe, expect, it } from "vitest";

import { extractImageUrl, safeImageUrl, MAX_IMAGE_URL_LENGTH } from "../src/images.mjs";

const PAGE = "https://grants.example.org/calls/2026";

describe("finding the picture", () => {
  it("prefers og:image, and resolves it against the page", () => {
    const html = `<meta property="og:image" content="/media/banner.jpg">`;
    expect(extractImageUrl(html, PAGE)).toBe("https://grants.example.org/media/banner.jpg");
  });

  it("prefers og:image:secure_url where a page offers both", () => {
    const html = `
      <meta property="og:image" content="https://cdn.example.org/plain.jpg">
      <meta property="og:image:secure_url" content="https://cdn.example.org/secure.jpg">`;
    expect(extractImageUrl(html, PAGE)).toBe("https://cdn.example.org/secure.jpg");
  });

  it("falls back to twitter:image, then to JSON-LD", () => {
    const twitter = `<meta name="twitter:image" content="https://cdn.example.org/t.jpg">`;
    expect(extractImageUrl(twitter, PAGE)).toBe("https://cdn.example.org/t.jpg");

    expect(extractImageUrl("", PAGE, [{ image: "https://cdn.example.org/ld.jpg" }])).toBe(
      "https://cdn.example.org/ld.jpg",
    );
    // schema.org lets `image` be an ImageObject or a list of them.
    expect(extractImageUrl("", PAGE, [{ image: { url: "https://cdn.example.org/o.jpg" } }])).toBe(
      "https://cdn.example.org/o.jpg",
    );
    expect(extractImageUrl("", PAGE, [{ image: ["https://cdn.example.org/first.jpg"] }])).toBe(
      "https://cdn.example.org/first.jpg",
    );
  });

  it("reads single quotes, odd spacing and `name=` for og tags", () => {
    // Real pages are not written the way a spec example is.
    const html = `<meta  property = 'og:image'   content='https://cdn.example.org/q.jpg' >`;
    expect(extractImageUrl(html, PAGE)).toBe("https://cdn.example.org/q.jpg");
    expect(extractImageUrl(`<meta name="og:image" content="https://cdn.example.org/n.jpg">`, PAGE)).toBe(
      "https://cdn.example.org/n.jpg",
    );
  });

  it("returns null rather than guessing when a page publishes nothing", () => {
    expect(extractImageUrl("<html><body><h1>A call</h1></body></html>", PAGE)).toBeNull();
    expect(extractImageUrl("", PAGE)).toBeNull();
    expect(extractImageUrl(`<meta property="og:image" content="">`, PAGE)).toBeNull();
  });
});

describe("what our own server is allowed to fetch", () => {
  it("refuses anything that is not https", () => {
    // An http image on an https page is blocked as mixed content anyway, so storing one
    // stores a URL that can never render.
    expect(safeImageUrl("http://cdn.example.org/a.jpg", null)).toBeNull();
    expect(safeImageUrl("//cdn.example.org/a.jpg", "http://plain.example.org/p")).toBeNull();
    expect(safeImageUrl("ftp://cdn.example.org/a.jpg", null)).toBeNull();
  });

  it("refuses the schemes that are not a fetch at all", () => {
    expect(safeImageUrl("data:image/png;base64,iVBORw0KGgo=", null)).toBeNull();
    expect(safeImageUrl("javascript:alert(1)", null)).toBeNull();
    expect(safeImageUrl("file:///etc/passwd", null)).toBeNull();
    expect(safeImageUrl("blob:https://x.example.org/abc", null)).toBeNull();
  });

  it("refuses private, loopback and metadata hosts", () => {
    // 169.254.169.254 is the cloud metadata endpoint. It is the reason this list exists.
    for (const host of [
      "localhost", "127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.9",
      "169.254.169.254", "[::1]", "box.local", "svc.internal", "0.0.0.0",
    ]) {
      expect(safeImageUrl(`https://${host}/a.jpg`, null), host).toBeNull();
    }
  });

  it("refuses a host with no dot, which is a bare internal name", () => {
    expect(safeImageUrl("https://intranet/a.jpg", null)).toBeNull();
  });

  it("refuses credentials and non-443 ports", () => {
    expect(safeImageUrl("https://user:pw@cdn.example.org/a.jpg", null)).toBeNull();
    expect(safeImageUrl("https://cdn.example.org:8080/a.jpg", null)).toBeNull();
    // The default port spelled out is the same URL, and is fine.
    expect(safeImageUrl("https://cdn.example.org:443/a.jpg", null)).toBe("https://cdn.example.org/a.jpg");
  });

  it("refuses a URL longer than the column will hold", () => {
    const long = `https://cdn.example.org/${"a".repeat(MAX_IMAGE_URL_LENGTH)}.jpg`;
    expect(safeImageUrl(long, null)).toBeNull();
  });

  it("drops the fragment, which no image server reads", () => {
    expect(safeImageUrl("https://cdn.example.org/a.jpg#hero", null)).toBe(
      "https://cdn.example.org/a.jpg",
    );
  });

  it("keeps the query string, which CDNs use for the actual file", () => {
    expect(safeImageUrl("https://cdn.example.org/a?w=1200&fm=jpg", null)).toBe(
      "https://cdn.example.org/a?w=1200&fm=jpg",
    );
  });

  it("skips an unusable candidate and takes the next one", () => {
    // The ordering only helps if a bad first answer does not end the search.
    const html = `
      <meta property="og:image" content="http://insecure.example.org/a.jpg">
      <meta name="twitter:image" content="https://cdn.example.org/good.jpg">`;
    expect(extractImageUrl(html, PAGE)).toBe("https://cdn.example.org/good.jpg");
  });
});
