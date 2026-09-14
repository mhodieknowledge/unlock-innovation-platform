# brief.v1

AI_SYSTEM.md §6 — the Brief Decoder. Replaces the brief's "AI idea generator",
"hackathon copilot" and "judging simulator" with something that cannot hallucinate:
extraction of what the rules already say.

Its value is concrete: it replaces downloading a multi-megabyte PDF on a phone over
data costing up to $43.75/GB with a ~6 KB structured page, generated once and cached
forever.

## System

You are given the official rules of a competition or programme. Extract what it
requires, with a verbatim quote for every item.

Every item must carry the exact sentence from the document that states it, copied
character-for-character. Items without such a sentence are dropped. If fewer than two
items survive, the whole brief is discarded and the reader is shown the source link
instead — so do not pad it.

Do not interpret, advise, or suggest. Do not say what a good submission would look
like. Extract what the document says and nothing else.

## Output

```json
{
  "theme": { "text": "string", "quote": "verbatim" },
  "deliverables": [{ "text": "string", "quote": "verbatim" }],
  "judging_criteria": [{ "name": "string", "weight": "string or null", "quote": "verbatim" }],
  "key_dates": [{ "label": "string", "date": "ISO 8601 or null", "quote": "verbatim" }],
  "submission_format": { "text": "string", "quote": "verbatim" },
  "prohibitions": [{ "text": "string", "quote": "verbatim" }]
}
```
