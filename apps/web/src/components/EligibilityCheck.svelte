<script lang="ts">
  /**
   * The anonymous eligibility check. UX_FLOWS.md §5, IMPLEMENTATION_PLAN.md §15
   * step 4.
   *
   * This is the ONE island on the opportunity detail route
   * (SYSTEM_ARCHITECTURE.md §3.2): the page HTML stays identical for every
   * viewer and fully cacheable, and the personal verdict is layered on top by
   * calling POST /api/v1/eligibility/evaluate.
   *
   * Inputs live in localStorage and are posted per request. Nothing is persisted
   * server-side for anonymous users (PRODUCT_SPEC.md §12.1). Three fields only —
   * country, student status, birth year — because those resolve most high-stakes
   * rules, and asking for more up front costs trust and data.
   */
  import { VERDICTS, RULE_OUTCOME_GLYPH, fieldLabel, verdictAnnouncement } from "../lib/verdict";
  import type { Verdict } from "../lib/verdict";

  interface RuleResult {
    type: string;
    outcome: string;
    confidence: number;
    source_quote: string;
    explanation: string;
    resolves_with?: string[];
  }

  interface VerdictPayload {
    opportunity_id: string;
    verdict: Verdict;
    confidence: number;
    rules: RuleResult[];
    missing_fields: string[];
    disclaimer: string;
  }

  let { opportunityId, officialUrl = "" }: { opportunityId: string; officialUrl?: string } =
    $props();

  const STORAGE_KEY = "mbele.eligibility.v1";

  type Status = "idle" | "checking" | "done" | "degraded" | "error";

  let country = $state("");
  let studentStatus = $state("");
  let birthYear = $state("");
  let remember = $state(true);
  let status = $state<Status>("idle");
  let result = $state<VerdictPayload | null>(null);
  let errorMessage = $state("");
  let restored = $state(false);

  const STATUSES: [string, string][] = [
    ["", "Prefer not to say"],
    ["secondary", "Secondary school"],
    ["undergraduate", "Undergraduate"],
    ["postgraduate", "Postgraduate"],
    ["recent_graduate", "Recent graduate"],
    ["not_student", "Not a student"],
  ];

  // Restoring saved answers is a convenience, so every access is guarded:
  // localStorage throws in a private window and returns null once cleared.
  $effect(() => {
    if (restored) return;
    restored = true;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return;
      const parsed = JSON.parse(saved) as Record<string, string>;
      country = parsed.country_of_residence ?? "";
      studentStatus = parsed.student_status ?? "";
      birthYear = parsed.birth_year ?? "";
      if (country || studentStatus || birthYear) void check();
    } catch {
      /* no saved answers, or storage unavailable — the form starts empty */
    }
  });

  function persist() {
    if (!remember) return;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          country_of_residence: country,
          student_status: studentStatus,
          birth_year: birthYear,
        }),
      );
    } catch {
      /* storage blocked; the verdict still works for this page view */
    }
  }

  async function check(event?: Event) {
    event?.preventDefault();
    status = "checking";
    errorMessage = "";
    persist();

    try {
      const response = await fetch("/api/v1/eligibility/evaluate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          opportunity_ids: [opportunityId],
          profile: {
            country_of_residence: country ? country.toUpperCase() : null,
            student_status: studentStatus || null,
            birth_year: birthYear ? Number(birthYear) : null,
          },
        }),
      });

      if (!response.ok) {
        // Invariant 10: an outage never produces a raw error. Say what we can and
        // cannot do, and point at the official page.
        status = "degraded";
        return;
      }

      const body = await response.json();
      result = body?.data?.verdicts?.[0] ?? null;
      status = body?.meta?.degraded_features?.length ? "degraded" : "done";
    } catch {
      status = "error";
      errorMessage = "We couldn't reach the server. Your answers are saved on this device.";
    }
  }

  function reopen() {
    status = "idle";
    result = null;
  }

  const presentation = $derived(VERDICTS[result?.verdict ?? "unknown"]);
  const announcement = $derived(
    result
      ? verdictAnnouncement(
          result.verdict,
          result.rules.map((r) => r.outcome),
          result.missing_fields,
        )
      : "",
  );
</script>

<div>
  {#if !result && status !== "degraded"}
    <form class="rounded-sheet border border-line bg-surface p-5" onsubmit={check}>
      <p class="text-meta text-ink-2">No account needed. Your answers stay on this device.</p>

      <div class="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label class="block">
          <span class="block text-meta font-semibold text-ink">Country you live in</span>
          <input
            bind:value={country}
            maxlength="2"
            placeholder="ZW"
            autocomplete="country"
            class="mt-[6px] h-12 w-full rounded-row border border-line-strong bg-surface px-3 uppercase focus:border-brand"
          />
        </label>

        <label class="block">
          <span class="block text-meta font-semibold text-ink">Student status</span>
          <select
            bind:value={studentStatus}
            class="mt-[6px] h-12 w-full rounded-row border border-line-strong bg-surface px-3 focus:border-brand"
          >
            {#each STATUSES as [value, label] (value)}
              <option {value}>{label}</option>
            {/each}
          </select>
        </label>

        <label class="block sm:col-span-2">
          <span class="block text-meta font-semibold text-ink">Birth year</span>
          <input
            bind:value={birthYear}
            inputmode="numeric"
            maxlength="4"
            placeholder="2004"
            class="mt-[6px] h-12 w-full max-w-[160px] rounded-row border border-line-strong bg-surface px-3 focus:border-brand"
          />
          <span class="mt-1 block text-meta text-ink-2"
            >We ask for the year only, never a full date of birth.</span
          >
        </label>
      </div>

      <label class="mt-4 flex items-center gap-2 text-meta text-ink-2">
        <input type="checkbox" bind:checked={remember} class="h-4 w-4 accent-brand" />
        Remember these on this device
      </label>

      <button
        type="submit"
        disabled={status === "checking"}
        class="mt-4 inline-flex h-12 items-center rounded-row bg-brand px-5 text-dense font-semibold text-surface hover:bg-brand-ink disabled:opacity-70"
      >
        {status === "checking" ? "Checking…" : "Check if you can apply"}
      </button>

      {#if status === "error"}
        <p class="mt-3 text-meta text-danger" role="alert">{errorMessage}</p>
      {/if}
    </form>
  {/if}

  {#if status === "degraded" && !result}
    <div class="rounded-sheet border border-line bg-sunken p-5">
      <p class="font-semibold">
        <span aria-hidden="true">{RULE_OUTCOME_GLYPH.unparsed}</span>
        We haven't confirmed the eligibility rules for this one.
      </p>
      <p class="mt-1 text-dense text-ink-2">
        Check the official page — it is the authority either way.
      </p>
      {#if officialUrl}
        <p class="mt-3">
          <a
            href={officialUrl}
            rel="noopener noreferrer nofollow ugc"
            target="_blank"
            class="font-semibold text-brand no-underline hover:underline">Open the official page</a
          >
        </p>
      {/if}
    </div>
  {/if}

  {#if result}
    <div class="rounded-sheet border border-line {presentation.wash} p-5">
      <p class="sr-only" aria-live="polite">{announcement}</p>

      <div class="flex items-center gap-3">
        <span class="flex size-10 shrink-0 items-center justify-center rounded-monogram bg-surface {presentation.ink} text-[18px]">
          <span aria-hidden="true">{presentation.glyph}</span>
        </span>
        <p class="{presentation.ink} text-subtitle font-bold tracking-[-0.01em] uppercase">
          {presentation.label}
        </p>
      </div>
      <p class="mt-2 text-dense text-ink-2">{presentation.summary}</p>

      {#if result.rules.length > 0}
        <ul class="mt-4 flex flex-col gap-3">
          {#each result.rules as rule (rule.type + rule.source_quote)}
            <li class="rounded-row bg-surface p-3">
              <p class="text-dense">
                <span aria-hidden="true">{RULE_OUTCOME_GLYPH[rule.outcome] ?? "○"}</span>
                {rule.explanation}
              </p>
              <!-- PRODUCT_SPEC.md §12.4: never state a verdict without the
                   sentence it came from. -->
              <p class="mt-1 border-l-2 border-line-strong pl-3 text-meta text-ink-2">
                &ldquo;{rule.source_quote}&rdquo;
              </p>
            </li>
          {/each}
        </ul>
      {/if}

      {#if result.missing_fields.length > 0}
        <p class="mt-4 text-dense">
          Add your {result.missing_fields.map(fieldLabel).join(", ")} to resolve this.
        </p>
        <button
          onclick={reopen}
          class="mt-2 h-11 rounded-row border border-line-strong bg-surface px-4 font-semibold"
          >Add the missing details</button
        >
      {/if}

      <p class="mt-4 text-meta text-ink-2">
        {result.disclaimer}
        {#if officialUrl}
          <a
            href={officialUrl}
            rel="noopener noreferrer nofollow ugc"
            target="_blank"
            class="font-semibold text-brand no-underline hover:underline">Official page</a
          >
        {/if}
      </p>

      <button onclick={reopen} class="mt-3 inline-flex min-h-11 items-center text-meta font-semibold text-brand underline"
        >Change my details</button
      >
    </div>
  {/if}
</div>
