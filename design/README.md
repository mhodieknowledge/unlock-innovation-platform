# Design canvas — the redesign proposal

Mockups, not application code. **Nothing in `apps/web/` is changed by anything in
this directory**, and nothing here ships to a user.

Published at https://claude.ai/artifact/MsVjtsknQUWwV1J8MsPnB3

## What is here

| File | What it is |
|---|---|
| `_style.css` | The shared stylesheet. Every value is lifted from `apps/web/src/styles/tokens.css` — no colour, type step, radius or breakpoint is invented. |
| `_head.html`, `_mid.html`, `_tail.html` | The wrapper each artboard is built from. |
| `*.body.html` | One artboard's content. **These are the sources to edit.** |
| `*.dc.html` | The built artboards: head + style + body + tail, concatenated. |
| `canvas.json` | Where each artboard sits on the canvas, and the sticky notes. |

## Rebuilding

```sh
cd design
for f in *.body.html; do
  cat _head.html _style.css _mid.html "$f" _tail.html > "${f%.body.html}.dc.html"
done
```

The published canvas is regenerated from the `.dc.html` files by the `/design`
skill's seeder; the 2.6 MB result is gitignored because it carries the whole
canvas editor with it.

## Three places this deliberately departs from the brief

1. **No full-height hero.** `UX FLOWS.md` §2 lists a hero image and a marketing
   hero as deliberately absent, because the live closing list *is* the hero, and
   `apps/web/test/home-route.test.ts` asserts the board renders above the fold.
   The masthead here is 270px: one sentence, the search, four category chips.
2. **The bottom navigation does not exist.** There is no fixed bottom bar in the
   source. The real mobile problem is the header's six-link `flex-wrap` row,
   which stacks onto three lines on a phone. `Shell.dc.html` replaces that.
3. **Colour stays reserved for eligibility.** `DESIGN SYSTEM.md` §1.2: colour
   appearing means something has been determined about *you*. Blue is action and
   links; the four-step ramp is verdicts; everything else is grey.

Opportunity titles, organisations and counts are placeholders. The live
catalogue is empty until a source is activated — see `RUNBOOK.md` §18.
