/* Scroll-reveal and animated stat counters — the homepage's motion layer.
 *
 * THE CAROUSEL THAT USED TO LIVE HERE IS GONE, with the section it served. It turned the
 * board into a one-at-a-time slide deck, which is the wrong shape for a deadline feed: a
 * reader choosing between two listings had to remember the first while swiping to the
 * second, and the controls for doing that were 8×8px dots. Half this file and 74 lines of
 * CSS went with it, on every page, for a section that showed one of eight rows. Everything here is progressive enhancement: the base HTML/CSS for every one of
 * these is already a complete, correct, fully-visible page (a stacked list, a static grid,
 * the final numbers) — this script only ever adds behaviour on top, never withholds content
 * that depends on it. A reader with JavaScript off, or a crawler, sees the same information
 * as a reader with it on, just without the motion. Served from /public as a plain classic
 * script (CSP allows 'self' and nothing else) rather than bundled, the same reasoning as
 * sw-register.js.
 *
 * [data-reveal]   fade/lift in once scrolled into view.
 * [data-count-to] a number that counts up from 0 once revealed. The server already rendered
 *                 the true final value as its text content, so this is decoration on a
 *                 number that was already correct.
 *
 * Nothing here starts moving on its own under prefers-reduced-motion.
 */
(function () {
  document.documentElement.classList.add("js-ready");

  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ── Reveal ────────────────────────────────────────────────────────────────
  var revealed = document.querySelectorAll("[data-reveal]");
  var io = null;
  if (revealed.length && "IntersectionObserver" in window) {
    io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -10% 0px" },
    );
    revealed.forEach(function (el) {
      io.observe(el);
    });
  } else {
    revealed.forEach(function (el) {
      el.classList.add("is-visible");
    });
  }

  // ── Stat counters ────────────────────────────────────────────────────────
  document.querySelectorAll("[data-count-to]").forEach(function (el) {
    var target = Number(el.getAttribute("data-count-to"));
    if (!isFinite(target)) return;
    if (reduceMotion) return;

    var run = function () {
      var start = null;
      var duration = 1100;
      function frame(ts) {
        if (start === null) start = ts;
        var p = Math.min(1, (ts - start) / duration);
        var eased = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(target * eased).toLocaleString("en");
        if (p < 1) window.requestAnimationFrame(frame);
        else el.textContent = target.toLocaleString("en");
      }
      el.textContent = "0";
      window.requestAnimationFrame(frame);
    };

    if (io) {
      var counterIo = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) {
              run();
              counterIo.unobserve(entry.target);
            }
          });
        },
        { threshold: 0.4 },
      );
      counterIo.observe(el);
    } else {
      run();
    }
  });

})();
