/* Service worker. SYSTEM_ARCHITECTURE.md §3.4, PRODUCT_SPEC.md §25.3.
 *
 * Four strategies, one per kind of thing, exactly as §3.4 specifies:
 *
 *   app shell         cache-first, versioned
 *   opportunity pages stale-while-revalidate, LRU 50
 *   user data         network-first with cache fallback
 *   writes offline    queued in IndexedDB, replayed on reconnect
 *
 * WHY THESE AND NOT A LIBRARY. Workbox is 20-40 KB of JavaScript to express four rules
 * that fit in one file, and PRODUCT_SPEC.md §25.3 exists for people on load-shedding and
 * cable outages — the exact people who cannot afford a framework to be told they are
 * offline. This is hand-written for the same reason the rest of the product is.
 *
 * WHAT IS DELIBERATELY NOT CACHED: anything authenticated except the tracker and the
 * personal surfaces, and no API response that carries another person's words. A cache is a
 * copy on a device somebody else may pick up, and PRIVACY_AND_COMPLIANCE.md §2's reasoning
 * about eligibility data applies with more force to a phone than to a database.
 */

// The routing rules live in their own file so a test can load them — see the note at the
// top of sw-routes.js. importScripts is synchronous and runs before any event handler, so
// self.MbeleRoutes is always defined below.
importScripts("/sw-routes.js");

const VERSION = "v1";
const SHELL = `shell-${VERSION}`;
const PAGES = `pages-${VERSION}`;
const DATA = `data-${VERSION}`;

/** §3.4: LRU 50. The last fifty opportunity pages the reader actually looked at. */
const PAGE_LIMIT = self.MbeleRoutes.LIMITS.pages;

/* The shell. Everything needed to render SOMETHING with no network at all. The CSS and the
 * offline page are the whole of it: there is no app bundle to cache, because there is no
 * app bundle. */
const SHELL_URLS = ["/offline", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // addAll fails the whole install if any URL 404s, which would leave the worker
      // uninstalled and the reader with no offline support at all. One at a time, and a
      // miss is survivable.
      await Promise.all(
        SHELL_URLS.map((url) => cache.add(url).catch(() => undefined)),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL, PAGES, DATA]);
      for (const name of await caches.keys()) {
        if (!keep.has(name)) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

/** Trim a cache to its limit, oldest first. The Cache API keeps insertion order. */
async function trim(cacheName, limit) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - limit; i += 1) {
    await cache.delete(keys[i]);
  }
}

/* ── The write queue ──────────────────────────────────────────────────────────
 *
 * §3.4: "queued in IndexedDB with a visible 'pending sync' state, replayed on reconnect
 * with conflict resolution by server timestamp".
 *
 * Only tracker writes are queued. A collaboration request or a message queued for hours
 * and replayed into a conversation that has moved on would be worse than a failure the
 * sender can see — and a deadline reminder does not need a queue at all.
 */
const DB_NAME = "mbele-outbox";
const STORE = "writes";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function enqueue(entry) {
  const db = await openDb();
  await promisify(tx(db, "readwrite").add(entry));
  return countQueued();
}

async function countQueued() {
  const db = await openDb();
  return promisify(tx(db, "readonly").count());
}

async function listQueued() {
  const db = await openDb();
  return promisify(tx(db, "readonly").getAll());
}

async function dropQueued(id) {
  const db = await openDb();
  await promisify(tx(db, "readwrite").delete(id));
}

/** Tell every open tab how many writes are waiting, so the page can show it. */
async function announce(kind) {
  const pending = await countQueued().catch(() => 0);
  const clients = await self.clients.matchAll({ type: "window" });
  for (const client of clients) {
    client.postMessage({ source: "mbele-sw", kind, pending });
  }
}

/**
 * Replay, oldest first, stopping at the first failure that is not the server's answer.
 *
 * Conflict resolution is "by server timestamp" (§3.4), and the server already does it: a
 * tracker state change is an UPDATE whose outcome depends on the row's current state, and
 * migration 0007 refuses an invalid transition. So a replayed write that the server refuses
 * is DROPPED rather than retried forever — the reader is told, and the server's view wins.
 */
async function replay() {
  const entries = await listQueued().catch(() => []);
  if (entries.length === 0) return;

  let sent = 0;
  let refused = 0;

  for (const entry of entries) {
    let response;
    try {
      response = await fetch(entry.url, {
        method: entry.method,
        headers: entry.headers,
        body: entry.body,
        credentials: "include",
      });
    } catch {
      // Still offline. Leave everything else queued and try again on the next signal.
      break;
    }

    if (response.ok || response.status === 303 || response.status === 302) {
      await dropQueued(entry.id);
      sent += 1;
    } else if (response.status >= 400 && response.status < 500) {
      // The server said no, and it will keep saying no. Dropping it is the honest
      // outcome; retrying would be a queue that never empties.
      await dropQueued(entry.id);
      refused += 1;
    } else {
      break;
    }
  }

  const clients = await self.clients.matchAll({ type: "window" });
  const pending = await countQueued().catch(() => 0);
  for (const client of clients) {
    // ONE message, whatever happened — the acceptance criterion is "one confirmation
    // toast", not one per write.
    client.postMessage({ source: "mbele-sw", kind: "replayed", sent, refused, pending });
  }
}

self.addEventListener("message", (event) => {
  if (event.data?.type === "replay") event.waitUntil?.(replay());
  if (event.data?.type === "pending") event.waitUntil?.(announce("pending"));
});

self.addEventListener("sync", (event) => {
  if (event.tag === "mbele-outbox") event.waitUntil(replay());
});

/* ── Fetch ────────────────────────────────────────────────────────────────── */

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const kind = self.MbeleRoutes.classify(
    request.url,
    self.location.origin,
    request.method,
  );

  switch (kind) {
    case "write-queue":
      // A tracker write made offline. Queued, and the page is told so it can show the
      // pending state rather than a failure.
      event.respondWith(queueWrite(request));
      return;
    case "shell":
    case "asset":
      event.respondWith(cacheFirst(request, SHELL));
      return;
    case "page":
      event.respondWith(staleWhileRevalidate(request));
      return;
    case "user":
      event.respondWith(networkFirst(request));
      return;
    case "navigate":
      // The list, the homepage, the policy pages: network with a cached fallback and the
      // offline page as the last resort. Nothing is stored speculatively.
      if (request.mode === "navigate") event.respondWith(networkFirst(request));
      return;
    default:
      // Untouched: cross-origin, API calls, admin, threads, auth. The browser handles them
      // exactly as it would with no service worker installed.
      return;
  }
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    return hit ?? Response.error();
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(PAGES);
  const hit = await cache.match(request);

  const fresh = fetch(request)
    .then(async (response) => {
      if (response.ok) {
        await cache.put(request, response.clone());
        await trim(PAGES, PAGE_LIMIT);
      }
      return response;
    })
    .catch(() => null);

  if (hit) {
    // Revalidate in the background; the reader gets the cached page immediately, which on
    // a slow connection is the difference between reading and waiting.
    return hit;
  }

  const response = await fresh;
  return response ?? offlineFallback();
}

async function networkFirst(request) {
  const cache = await caches.open(DATA);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    const hit = await cache.match(request);
    return hit ?? offlineFallback();
  }
}

async function offlineFallback() {
  const cache = await caches.open(SHELL);
  const page = await cache.match("/offline");
  return (
    page ??
    new Response("You are offline, and this page was not saved.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    })
  );
}

/**
 * Queue a write and answer as if it had happened.
 *
 * The response is a redirect back to where the form posted from, with a marker the page
 * reads to show "waiting to sync". Answering with an error instead would be accurate about
 * the network and useless to the reader, who did the thing and wants it remembered.
 */
async function queueWrite(request) {
  try {
    // Try the network first: offline is the exception, not the rule.
    return await fetch(request.clone());
  } catch {
    const body = await request.clone().text();
    const headers = {};
    for (const [key, value] of request.headers.entries()) {
      // Only what the replay needs. Copying everything would include hop-by-hop headers a
      // replayed fetch must not set.
      if (key === "content-type") headers[key] = value;
    }

    await enqueue({
      url: request.url,
      method: request.method,
      headers,
      body,
      queued_at: new Date().toISOString(),
    });

    await announce("queued");

    if ("sync" in self.registration) {
      await self.registration.sync.register("mbele-outbox").catch(() => undefined);
    }

    const back = new URL(request.referrer || "/tracker", self.location.origin);
    back.searchParams.set("queued", "1");
    return Response.redirect(back.toString(), 303);
  }
}
