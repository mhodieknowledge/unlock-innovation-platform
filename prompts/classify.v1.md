# classify.v1

AI_SYSTEM.md §4. Versioned as a file in the repo (§12): changing this file requires the
golden set to pass and writes a row to the admin audit log.

Referenced by `ai_providers.task = 'classify'`. The model name is never in here — it is a
configuration row (§2 guardrail 6).

## Why this task exists separately from extraction

Extraction assigns a category as one field among thirty, and only ever runs on a page the
crawler fetched. Two kinds of record never reach it:

- An API source (Devpost, Kaggle, the GitHub API) arrives as schema.org nodes that
  `recordFromJsonLd` turns into records directly, with no model call at all by design — and
  schema.org has no field for our taxonomy.
- Anything already filed as `other` during the months when the extract prompt's list of codes
  and the `categories` table were different vocabularies.

`packages/ingest/src/categorise.mjs` handles the ones that say what they are in the title,
free and deterministically. This task is for the rest.

## Why it asks for a quote and not just an answer

The first version of this file asked for a code and nothing else. Its first run against the
live catalogue moved three records and two were wrong:

    scholarship       ← The Government of Japan Exchange and Teaching Programme
    data_competition  ← R.O.A.D. Barbados Historic Handwriting Challenge

The JET Programme is a teaching job abroad. The Barbados challenge is a volunteer
transcription project. Neither has a word in this taxonomy, the instructions said to answer
`other` when nothing fits, and the model reached for the nearest thing anyway — which is the
failure mode a permitted `other` was supposed to prevent and does not.

So the model no longer states a category. It FINDS THE PHRASE in the page that names what the
thing is, and the same deterministic reader that handles titles reads that phrase. That is
`rules.v1`'s arrangement, where "output is verbatim-quote validated regardless of model", and
it divides the work along the line where each side is strong: deciding WHICH sentence is the
declaration is a judgement about language, which a model makes well and a pattern cannot make
at all; reading a declarative phrase is a pattern's job, and it does not embellish.

A quote that is not in the page is discarded. A quote that does not itself name the category
the model chose is discarded. The record keeps `other`, which costs a reader nothing — the
listing is still on the board and still searchable — where a wrong category is a wrong promise.

## What the caller guarantees

The vocabulary is filled from the `categories` table at call time, so this file holds no copy
of it: a prompt's list and the database's list drifting apart is the bug that put eighteen of
twenty-one category pages at zero records.

## System

You are shown one opportunity listing and the text of its page. Find the phrase in that text
which says WHAT KIND OF THING this is.

Return two fields:

- `evidence`: a phrase COPIED CHARACTER FOR CHARACTER from the source, between three and
  twenty words, which names the kind of thing being offered. Not a phrase about the prize, not
  about what the organiser also runs, not about what a panel will discuss — the phrase that
  names THIS.
- `category_code`: EXACTLY one of: {{CATEGORY_CODES}}

The code must be the kind of thing your `evidence` names. If the page calls it a teaching
exchange, there is no code for that: answer `other`. If it calls it a volunteer project, there
is no code for that either.

Rules:

- `other` with `evidence: null` is a correct answer and a frequent one. Most of what reaches
  this prompt has no word in the list, because everything that did was already read from its
  title before you were asked.
- Never invent a phrase. If you cannot find one in the page, return `other` and null evidence.
  Your quote is checked against the page, and an invented one is discarded.
- A competition whose prize is a scholarship is a competition, not a scholarship. A fellowship
  for people working on innovation is a fellowship, not an innovation challenge. A conference
  that offers travel grants is not a grant.
- An article explaining how to apply for something is not an opportunity: answer `other`.
- Return JSON only: `{"category_code": "...", "evidence": "..." }`.
