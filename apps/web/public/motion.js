/* Scroll-reveal, a real slide carousel, and animated stat counters — the homepage's motion
 * layer. Everything here is progressive enhancement: the base HTML/CSS for every one of
 * these is already a complete, correct, fully-visible page (a stacked list, a static grid,
 * the final numbers) — this script only ever adds behaviour on top, never withholds content
 * that depends on it. A reader with JavaScript off, or a crawler, sees the same information
 * as a reader with it on, just without the motion. Served from /public as a plain classic
 * script (CSP allows 'self' and nothing else) rather than bundled, the same reasoning as
 * sw-register.js.
 *
 * [data-reveal]   fade/lift in once scrolled into view.
 * [data-carousel] a stacked block of [data-slide] children becomes a real one-at-a-time
 *                 slide deck: dot indicators, prev/next arrows, autoplay, swipe, arrow-key
 *                 navigation. Without this script the slides simply stack as normal block
 *                 content — a complete list, not a truncated preview.
 * [data-count-to] a number that counts up from 0 once revealed. The server already rendered
 *                 the true final value as its text content, so this is decoration on a
 *                 number that was already correct.
 *
 * Nothing here starts moving on its own under prefers-reduced-motion, and autoplay pauses
 * the instant a pointer, touch or keyboard focus reaches it — WCAG 2.2.2.
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

  // ── Carousel ─────────────────────────────────────────────────────────────
  document.querySelectorAll("[data-carousel]").forEach(function (root) {
    var slides = Array.prototype.slice.call(root.querySelectorAll("[data-slide]"));
    if (slides.length < 2) return;

    root.classList.add("carousel-ready");
    var track = document.createElement("div");
    track.className = "carousel-track";
    slides.forEach(function (slide) {
      slide.classList.add("carousel-slide");
      track.appendChild(slide);
    });
    root.appendChild(track);

    var dots = document.createElement("div");
    dots.className = "carousel-dots";
    dots.setAttribute("role", "tablist");
    dots.setAttribute("aria-label", "Slides");
    var dotEls = slides.map(function (_, i) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "carousel-dot";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-label", "Go to slide " + (i + 1) + " of " + slides.length);
      b.addEventListener("click", function () {
        goTo(i);
        stopAuto();
      });
      dots.appendChild(b);
      return b;
    });
    root.appendChild(dots);

    ["prev", "next"].forEach(function (dir) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "carousel-arrow carousel-arrow-" + dir;
      b.setAttribute("aria-label", dir === "prev" ? "Previous slide" : "Next slide");
      b.innerHTML =
        dir === "prev"
          ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 5l-7 7 7 7"/></svg>'
          : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 5l7 7-7 7"/></svg>';
      b.addEventListener("click", function () {
        goTo(index + (dir === "prev" ? -1 : 1));
        stopAuto();
      });
      root.appendChild(b);
    });

    var index = 0;
    function goTo(i) {
      index = (i + slides.length) % slides.length;
      track.style.transform = "translateX(-" + index * 100 + "%)";
      dotEls.forEach(function (d, i2) {
        d.setAttribute("aria-selected", i2 === index ? "true" : "false");
      });
    }
    goTo(0);

    var autoTimer = null;
    function startAuto() {
      if (reduceMotion) return;
      stopAuto();
      autoTimer = setInterval(function () {
        goTo(index + 1);
      }, 5200);
    }
    function stopAuto() {
      if (autoTimer) {
        clearInterval(autoTimer);
        autoTimer = null;
      }
    }
    root.addEventListener("pointerenter", stopAuto);
    root.addEventListener("pointerleave", startAuto);
    root.addEventListener("focusin", stopAuto);
    root.addEventListener("focusout", startAuto);
    root.setAttribute("tabindex", "0");
    root.addEventListener("keydown", function (e) {
      if (e.key === "ArrowLeft") {
        goTo(index - 1);
        stopAuto();
      } else if (e.key === "ArrowRight") {
        goTo(index + 1);
        stopAuto();
      }
    });

    var startX = null;
    root.addEventListener(
      "touchstart",
      function (e) {
        startX = e.touches[0].clientX;
        stopAuto();
      },
      { passive: true },
    );
    root.addEventListener(
      "touchend",
      function (e) {
        if (startX === null) return;
        var dx = e.changedTouches[0].clientX - startX;
        if (Math.abs(dx) > 40) goTo(index + (dx < 0 ? 1 : -1));
        startX = null;
        startAuto();
      },
      { passive: true },
    );

    startAuto();
  });
})();
