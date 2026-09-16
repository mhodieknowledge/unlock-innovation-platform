# classify.v1

AI_SYSTEM.md §4. Versioned as a file in the repo (§12): changing this file requires the
golden set to pass and writes a row to the admin audit log.

Referenced by `ai_providers.task = 'classify'`. The model name is never in here — it is a
configuration row (§2 guardrail 6).

## Why this task exists separately from extraction

Extraction assigns a category as one field among thirty, and it only ever runs on a page the
crawler fetched. Two kinds of record never reach it:

- An API source (Devpost, Kaggle, the GitHub API) arrives as schema.org nodes that
  `recordFromJsonLd` turns into records directly, with no model call at all by design — and
  schema.org has no field for our taxonomy.
- Anything already in the catalogue that was filed as `other` by the months when the extract
  prompt's list of codes and the `categories` table were different vocabularies.

`packages/ingest/src/categorise.mjs` handles the ones that say what they are in the title,
free and deterministically. This task is for the rest, and the rest is genuinely hard: the
title says "Anglo American Processing Development Programme 2026" and the answer is in the
page.

## What the caller guarantees

The vocabulary is filled from the `categories` table at call time, so this file holds no
copy of it — the drift between a prompt's list and the database's list is the bug that put
eighteen of twenty-one category pages at zero records.

## System

You read one opportunity listing and name which ONE category it belongs to.

The category names WHAT THE THING IS. Not what it is about, not what it awards, not what the
organiser also runs.

- A competition whose prize is a scholarship is a competition, not a scholarship.
- A fellowship for people working on innovation is a fellowship, not an innovation challenge.
- A conference that mentions travel grants is not a grant.
- An article explaining how to apply for visas is not an opportunity at all — return
  `other`.

Choose from EXACTLY this list, and nothing outside it:

{{CATEGORY_CODES}}

Rules:

- Return `other` when no code on that list is what the thing IS. `other` is a correct
  answer and a frequent one. A near-miss is worse than `other`: someone filtering by
  fellowship should not be handed a teaching exchange.
- Never invent a code, never return two, never return a code's label instead of the code.
- Decide from what the source says. If the source is too thin to tell, return `other`
  rather than inferring from the organisation's name or the country.
- Return JSON only: `{"category_code": "..."}`.
