# The golden set

AI_SYSTEM.md §12 `[PR]` specifies:

> **Golden set:** 60 hand-labelled real opportunities spanning every category, all six
> Tier-1 countries and every rule type. Checked into the repo as fixtures.

## What is here, and what is not

**Not here: the 60 hand-labelled real opportunities.** This directory holds
SYNTHETIC fixtures, every one marked `"synthetic": true`, written to exercise the
failure modes the validators exist to catch. They prove the harness works and make the
gate real. They are not a substitute for the specified set, and they are not labelled
as one.

Why they are not here: hand-labelling means a person reading a real organiser's page
and recording what it actually says. A coding agent writing 60 plausible-looking
"real" records would be fabricating exactly the kind of data invariant 9 exists to
prevent — and the fabrication would then be the thing the quality gate measures
against, which is worse than having no gate.

**What is needed to close this, concretely:**

1. 60 real opportunity pages, saved as text alongside their source URL and fetch date.
2. For each: the correct deadline (value and precision), the correct country
   eligibility, the correct cost, and every eligibility rule with the verbatim
   sentence that states it.
3. Coverage: all 21 categories, all six Tier-1 countries (Zimbabwe, Zambia, Botswana,
   Namibia, Malawi, Mozambique), and all 17 rule types.
4. Labelled by a person, not by a model — the point of a golden set is that it is
   independent of the thing being measured.

Until then, `npm run eval` reports the coverage it actually has, and says so in its
output rather than presenting a number as if the specified set existed.

## Format

```jsonc
{
  "id": "G01",
  "synthetic": true,
  "note": "which trap this case sets",
  "document": "the page text, as the pipeline would see it after normalisation",
  "profile": { /* optional: an eligibility profile, for the false-eligible check */ },
  "expected": {
    "deadline_at": "2027-03-15T00:00:00.000Z",   // or null
    "deadline_precision": "date_only",
    "eligibility_scope": "country_list",
    "eligible_countries": ["ZW", "ZM", "MW"],
    "cost": "free",
    "verdict": "eligible",                        // what the engine should conclude
    "rules": [{ "rule_type": "country_in", "countries": ["ZW", "ZM", "MW"] }]
  },
  "recorded": {
    "prompt_version": "extract.v1",
    "extract_reply": "the model's raw reply, recorded verbatim",
    "rules_reply": "the model's raw reply, recorded verbatim"
  }
}
```

## Why the model replies are RECORDED rather than called live

A quality gate has to be deterministic to be a gate. Recorded replies mean `npm run
eval` runs in CI with no API key, gives the same answer twice, and measures exactly
what the deterministic validators do with a given model output — which is the part
that decides whether something untrue reaches a user.

`npm run eval -- --live` calls the real providers and rewrites the recordings, which
is how a prompt change is evaluated before it ships.

The recorded replies in the synthetic fixtures are hand-written to represent what a
small model plausibly returns, including its characteristic mistakes: a paraphrase
presented as a quote, a country list it invented, a locale-ambiguous date, a summary
lifted from the page. They are not real model output and are marked accordingly.
