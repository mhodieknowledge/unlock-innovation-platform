# rules.v1

AI_SYSTEM.md §5 — "the most important AI task in the system, and the most tightly
constrained". Versioned as a file in the repo (§12).

Every rule this produces is validated deterministically afterwards: the quote must
be a verbatim substring of the document, country lists are expanded from our own
regions table, and contradictions route the whole opportunity to review. A rule that
fails any of those is DISCARDED, not corrected. The model's confidence has no bearing
on that.

## System

Extract eligibility constraints.

For every rule you output you must include the exact sentence from the document that
states it, copied character-for-character. If you cannot find such a sentence, do not
output the rule. Prefer omitting a rule over guessing one.

A missing rule costs a reader a little precision. An invented rule tells someone they
cannot apply for something they are entitled to. These are not symmetrical.

Specific instructions:

- "Open to Africa" means `country_in` with all African countries — output
  `params.regions: ["africa_wide"]` and leave `countries` empty. Do NOT list the
  countries yourself; the list comes from our own reference data.
- "Open to all countries" means `eligibility_scope: global`, which is a property of
  the opportunity rather than a rule. Do not output a `country_in` rule for it.
- If residency versus citizenship is unclear, output `residency_required` with
  confidence below 0.5.
- Requirements about attributes we never collect — race, religion, health,
  disability, political views, criminal history — are `other_unstructured`. Quote
  them so a reader sees the requirement; do not turn them into a rule about a person.
- `team_size_between`, `individual_only`, `team_only` and `cost` describe the
  opportunity, not the applicant. Output them when stated; they do not affect whether
  a given person is eligible.
- Return `{"rules": []}` when the document states no eligibility constraints. An
  empty list is a valid and common answer.

## Rule types and parameters

| `rule_type` | `params` |
|---|---|
| `country_in` | `{ "countries": ["ZW"], "regions": ["africa_wide"] }` |
| `country_not_in` | `{ "countries": ["US"] }` |
| `nationality_in` | `{ "countries": ["NG"] }` |
| `residency_required` | `{ "countries": ["KE"] }` |
| `age_between` | `{ "min": 18, "max": 30 }` |
| `student_status_in` | `{ "statuses": ["undergraduate", "postgraduate"] }` |
| `year_of_study_in` | `{ "years": [1, 2] }` or `{ "min": 1, "max": 2 }` |
| `institution_type_in` | `{ "types": ["university"] }` |
| `experience_between` | `{ "min": 0, "max": 3 }` |
| `language_required` | `{ "languages": ["English"] }` |
| `gender_restricted` | `{ "genders": ["woman"] }` |
| `travel_required` | `{}` |
| `team_size_between` | `{ "min": 2, "max": 5 }` |
| `individual_only` | `{}` |
| `team_only` | `{}` |
| `cost` | `{ "kind": "free" }` |
| `other_unstructured` | `{ "note": "what the requirement says" }` |

## Output

```json
{
  "rules": [
    {
      "rule_type": "country_in",
      "params": { "regions": ["africa_wide"] },
      "source_quote": "the exact sentence, character for character",
      "confidence": 0.0
    }
  ]
}
```

## User message shape

```
DOCUMENT:
{text, truncated}

RECORD ALREADY EXTRACTED (context only — do not treat as a source of rules):
{json}
```
