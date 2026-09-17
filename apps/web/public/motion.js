/* Scroll-reveal and gentle auto-scroll for the marketing surfaces (currently the homepage).
 *
 * Progressive enhancement, not a requirement: tokens.css only hides a [data-reveal] element
 * once `html` carries `.js-ready`, which this script is the only thing that adds — so a
 * reader with JavaScript off, or a crawler, sees every section fully visible and never
 * hidden behind a script that didn't run. Served from /public as a plain classic script
 * (CSP allows 'self' and nothing else) rather than bundled, the same reasoning as
 * sw-register.js.
 *
 * Auto-scroll only runs a `requestAnimationFrame` loop for elements explicitly marked
 * [data-autoscroll], pauses the instant a pointer or touch is on the row, and never starts
 * at all under prefers-reduced-motion — WCAG 2.2.2 (Pause, Stop, Hide) for content that
 * moves on its own.
 */
(function () {
  document.documentElement.classList.add("js-ready");

  var revealed = document.querySelectorAll("[data-reveal]");
  if (revealed.length) {
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(
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
  }

  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion) return;

  document.querySelectorAll("[data-autoscroll]").forEach(function (row) {
    var paused = false;
    var resumeTimer = null;

    function pause() {
      paused = true;
      if (resumeTimer) {
        clearTimeout(resumeTimer);
        resumeTimer = null;
      }
    }
    function resumeSoon() {
      if (resumeTimer) clearTimeout(resumeTimer);
      resumeTimer = setTimeout(function () {
        paused = false;
      }, 2200);
    }

    row.addEventListener("pointerenter", pause);
    row.addEventListener("pointerleave", resumeSoon);
    row.addEventListener("focusin", pause);
    row.addEventListener("focusout", resumeSoon);
    row.addEventListener("touchstart", pause, { passive: true });
    row.addEventListener("touchend", resumeSoon, { passive: true });

    var speed = Number(row.getAttribute("data-autoscroll")) || 0.5;

    function step() {
      if (!paused && row.scrollWidth > row.clientWidth) {
        var atEnd = row.scrollLeft + row.clientWidth >= row.scrollWidth - 1;
        row.scrollLeft = atEnd ? 0 : row.scrollLeft + speed;
      }
      window.requestAnimationFrame(step);
    }
    window.requestAnimationFrame(step);
  });
})();
