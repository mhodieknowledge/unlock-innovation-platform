/* Service-worker registration and the pending-sync indicator.
 *
 * SYSTEM_ARCHITECTURE.md §3.4 requires "a visible 'pending sync' state", and Phase 9's
 * acceptance criterion asks for "one confirmation toast" when a queued change syncs. Both
 * live here, in about a kilobyte, because the alternative is a framework.
 *
 * Served from /public rather than bundled, so it is a plain classic script: the CSP allows
 * 'self' and nothing else, and this file needs no build step to satisfy that.
 */
(function () {
  if (!("serviceWorker" in navigator)) return;

  var registration = null;

  navigator.serviceWorker
    .register("/sw.js", { scope: "/" })
    .then(function (reg) {
      registration = reg;
      ask("pending");
      // A reader who comes back online mid-session should not have to reload for their
      // queued change to go out.
      window.addEventListener("online", function () {
        ask("replay");
      });
      if (navigator.onLine) ask("replay");
    })
    .catch(function () {
      // No offline support. Everything still works; nothing is said about it, because a
      // reader who cannot install a service worker cannot do anything about it either.
    });

  function ask(type) {
    var target = navigator.serviceWorker.controller || (registration && registration.active);
    if (target) target.postMessage({ type: type });
  }

  navigator.serviceWorker.addEventListener("message", function (event) {
    var data = event.data || {};
    if (data.source !== "mbele-sw") return;

    if (data.kind === "replayed") {
      if (data.sent > 0) {
        toast(
          data.sent === 1
            ? "Your change has been saved."
            : data.sent + " changes have been saved.",
        );
      }
      if (data.refused > 0) {
        toast(
          data.refused === 1
            ? "One change could not be applied — open your tracker to see where it got to."
            : data.refused + " changes could not be applied — open your tracker to see.",
        );
      }
    }

    paint(data.pending || 0);
  });

  /** The persistent pending count. Not a toast: it stays until the queue empties. */
  function paint(pending) {
    var node = document.querySelector("[data-pending-sync]");
    if (!node) return;
    if (pending > 0) {
      node.textContent =
        pending === 1
          ? "1 change is waiting to sync. It will go out when you are back online."
          : pending + " changes are waiting to sync. They go out when you are back online.";
      node.hidden = false;
    } else {
      node.hidden = true;
    }
  }

  /* ── The install prompt ──────────────────────────────────────────────────────
   *
   * IMPLEMENTATION_PLAN.md §11: "install prompt at an appropriate moment". The moment is
   * chosen by the PAGE, not by this script: the markup below only exists on the tracker once
   * the reader has saved something, because somebody with a tracker is somebody who will come
   * back, and that is the only honest argument for installing anything.
   *
   * UX_FLOWS.md §1 forbids interstitials and modals on arrival, so this is an inline row that
   * can be dismissed once and never returns. The browser's own criteria still apply: if it
   * never fires beforeinstallprompt — already installed, unsupported, or the reader has not
   * engaged enough for its liking — nothing appears and nothing is said about it.
   */
  var DISMISSED = "mbele-install-dismissed";
  var deferredPrompt = null;

  function remember() {
    try {
      window.localStorage.setItem(DISMISSED, "1");
    } catch (e) {
      // Private mode, or storage disabled. The row simply reappears next visit, which is a
      // better failure than a script that throws on a page the reader is trying to read.
    }
  }

  function dismissed() {
    try {
      return window.localStorage.getItem(DISMISSED) === "1";
    } catch (e) {
      return false;
    }
  }

  window.addEventListener("beforeinstallprompt", function (event) {
    // Chromium shows its own mini-infobar unless this is prevented, which is the interstitial
    // §1 rules out. Keeping the event lets the reader ask for it when they choose.
    event.preventDefault();
    deferredPrompt = event;

    var host = document.querySelector("[data-install-prompt]");
    if (!host || dismissed()) return;
    host.hidden = false;
  });

  window.addEventListener("appinstalled", function () {
    remember();
    var host = document.querySelector("[data-install-prompt]");
    if (host) host.hidden = true;
  });

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || !target.closest) return;

    if (target.closest("[data-install-accept]")) {
      event.preventDefault();
      var host = document.querySelector("[data-install-prompt]");
      if (host) host.hidden = true;
      remember();
      if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt = null;
      }
      return;
    }

    if (target.closest("[data-install-dismiss]")) {
      event.preventDefault();
      var dismissHost = document.querySelector("[data-install-prompt]");
      if (dismissHost) dismissHost.hidden = true;
      remember();
    }
  });

  /**
   * One line, announced to a screen reader, gone after eight seconds.
   *
   * No animation and no close button: DESIGN_SYSTEM.md keeps motion out of the way of
   * reading, and a message that removes itself needs no control.
   */
  function toast(message) {
    var host = document.querySelector("[data-toast]");
    if (!host) return;
    host.textContent = message;
    host.hidden = false;
    window.setTimeout(function () {
      host.hidden = true;
      host.textContent = "";
    }, 8000);
  }
})();
