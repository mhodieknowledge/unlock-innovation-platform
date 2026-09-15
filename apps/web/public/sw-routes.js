/* Which caching strategy applies to which URL. SYSTEM_ARCHITECTURE.md §3.4.
 *
 * A SEPARATE FILE, and imported by the service worker with importScripts, for one reason:
 * a test can read it. The routing rules are the part of a service worker most likely to be
 * quietly wrong — a pattern that catches an authenticated page and caches somebody's
 * tracker onto a shared phone, or one that misses opportunity pages so nothing works
 * offline at all — and a rule nobody can test is a rule nobody can trust.
 *
 * apps/web/test/service-worker.test.ts loads this file and asserts the classification of
 * three dozen real paths. It is plain ES5-ish script rather than a module because a classic
 * service worker importScripts() it, and the CSP allows scripts from 'self' only.
 */
(function (scope) {
  var LIMITS = {
    /* §3.4: "Opportunity pages: stale-while-revalidate, LRU 50." */
    pages: 50,
  };

  /**
   * @param {string} href absolute URL
   * @param {string} origin the worker's own origin
   * @returns {"skip"|"shell"|"asset"|"page"|"user"|"navigate"|"write-queue"}
   */
  function classify(href, origin, method) {
    var url;
    try {
      url = new URL(href, origin);
    } catch (e) {
      return "skip";
    }

    if (url.origin !== origin) return "skip";

    var path = url.pathname;

    if ((method || "GET") !== "GET") {
      // Only tracker writes are queued offline. A collaboration request replayed into a
      // conversation that has moved on would be worse than a failure the sender can see.
      if (path === "/tracker" || path.indexOf("/api/v1/tracker") === 0) return "write-queue";
      return "skip";
    }

    if (path === "/offline" || path === "/manifest.webmanifest") return "shell";

    // Content-hashed build output. Cache-first forever is what the hash is for.
    if (path.indexOf("/_a/") === 0) return "asset";

    // The tracker, and ONLY the tracker: §3.4 names "the user's tracker and their saved items"
    // and nothing else personal. Network-first, so a cached copy is only ever the fallback.
    if (path === "/tracker") return "user";

    /* Every other personal surface is network-only, deliberately.
     *
     * /you/eligibility is the eligibility profile, which DATA_MODEL.md §15 gives one read
     * principal and PRIVACY_AND_COMPLIANCE.md §2 treats as the most sensitive thing here;
     * /you/inbox carries notification headlines with other people's names in them. A cache is
     * a copy on a device somebody else may pick up, and §3.4's list is the whole warrant for
     * making such a copy. Being unable to read your dashboard on a plane is a smaller cost.
     */
    if (path === "/you" || path.indexOf("/you/") === 0) return "skip";

    // NEVER cached: other people's words, and anything that is a write surface or an
    // administrative view. A cache is a copy on a device somebody else may pick up.
    if (
      path.indexOf("/admin") === 0 ||
      path.indexOf("/threads") === 0 ||
      path.indexOf("/requests") === 0 ||
      path.indexOf("/api/") === 0 ||
      path.indexOf("/auth/") === 0 ||
      path.indexOf("/organisations/claims") === 0 ||
      path.indexOf("/low-data") === 0
    ) {
      return "skip";
    }

    // An opportunity page caches; everything nested under one does not. A room is other
    // people's presence and changes by the hour; an intent or team form is a write surface.
    // Getting this the other way round — falling through to "navigate" — meant a room was
    // cached as a page and served stale to the next reader, which the routing test caught
    // on its first run.
    if (path.indexOf("/opportunities/") === 0) {
      if (
        path.indexOf("/room") !== -1 ||
        path.indexOf("/intent") !== -1 ||
        path.indexOf("/teams") !== -1
      ) {
        return "skip";
      }
      return "page";
    }

    return "navigate";
  }

  scope.MbeleRoutes = { classify: classify, LIMITS: LIMITS };
})(typeof self !== "undefined" ? self : this);
