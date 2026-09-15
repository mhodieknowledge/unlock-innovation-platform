#!/usr/bin/env node
/**
 * The dependency audit gate. SECURITY.md §12.
 *
 * `npm audit --audit-level=high` was the gate, and it had been failing on every CI run
 * for days by 2026-09-15 — not on anything new, but on four advisories with no fixed
 * version to move to. A gate that is always red is not a gate: nobody can tell the run
 * that found something from the twenty before it that found the same thing, so the
 * signal is gone and the next real advisory arrives into a build that was already
 * failing. That is worse than no audit, because it looks like one.
 *
 * So the audit still runs, still at `high`, and still fails the build — but the
 * advisories below are named, reasoned about, and excluded by ID. Anything else fails,
 * including a NEW advisory against the same package: the allowlist is keyed on the
 * advisory, not on the dependency, so suppressing one finding never suppresses the next.
 *
 * To clear an entry: upgrade until `npm audit` stops reporting it, then delete it here.
 * The script says when an entry has gone stale so the list cannot quietly outlive its
 * reasons.
 */

import { execFileSync } from "node:child_process";

/**
 * Accepted, with the reasoning that makes each one acceptable. An entry is a decision
 * someone has to be able to disagree with later, so `why` is the real argument and not
 * a restatement of the advisory.
 *
 * @type {Array<{ id: string, package: string, why: string, revisit: string }>}
 */
const ACCEPTED = [
  {
    id: "GHSA-xcpc-8h2w-3j85",
    package: "adm-zip",
    why: "Crafted ZIP triggers a 4 GB allocation. Reached only through onnxruntime-node, "
      + "which uses adm-zip to unpack the embedding model it downloads from Hugging Face "
      + "at a pinned revision (AI_SYSTEM.md §3.3). The pipeline never hands adm-zip an "
      + "archive from a source, a publisher or a user; the one archive it ever opens is "
      + "the model bundle. No fixed version of adm-zip exists, and @huggingface/"
      + "transformers is already at its latest (4.2.0).",
    revisit: "when @huggingface/transformers releases past 4.2.0",
  },
  {
    id: "GHSA-vwc7-r8mq-g2x9",
    package: "adm-zip",
    why: "Extraction follows destination symlinks, allowing arbitrary file overwrite. "
      + "Same reach and same single archive as above, and the extraction happens on an "
      + "ephemeral Actions runner rather than anywhere with state worth overwriting.",
    revisit: "when @huggingface/transformers releases past 4.2.0",
  },
  {
    id: "GHSA-f88m-g3jw-g9cj",
    package: "sharp",
    why: "libvips CVEs reachable by processing a hostile image. Only the copy nested "
      + "under @huggingface/transformers (0.34.5) is in range — Astro's own sharp is "
      + "0.35.4, above the advisory's <=0.35.4-rc.0. That nested copy exists for "
      + "transformers' image models, and this project embeds text: scripts/embed.mjs "
      + "runs a sentence-transformer over opportunity titles and summaries and never "
      + "passes sharp an image.",
    revisit: "when @huggingface/transformers releases past 4.2.0",
  },
  {
    id: "GHSA-rgj7-g3m4-5g8c",
    package: "sharp",
    why: "libheif CVEs in the same nested 0.34.5 copy, reachable the same way and not "
      + "reached for the same reason.",
    revisit: "when @huggingface/transformers releases past 4.2.0",
  },
];

/** §12's level. Anything at or above this fails unless it is named above. */
const FAIL_AT = new Set(["high", "critical"]);

const accepted = new Map(ACCEPTED.map((entry) => [entry.id, entry]));

/**
 * `npm audit --json` exits non-zero whenever it finds anything, so the exit code is not
 * the answer and the output is. execFileSync throws on that exit code with the payload
 * on the error, which is why both paths below read the same field.
 */
function auditReport() {
  try {
    return JSON.parse(execFileSync("npm", ["audit", "--json"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
  } catch (err) {
    const stdout = /** @type {any} */ (err)?.stdout;
    if (typeof stdout === "string" && stdout.trim().startsWith("{")) return JSON.parse(stdout);
    throw err;
  }
}

const report = auditReport();

/** @type {Array<{ id: string, severity: string, package: string, title: string }>} */
const found = [];
for (const [name, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of /** @type {any} */ (vulnerability).via ?? []) {
    // A string in `via` is a transitive path back to another entry in the same report,
    // not an advisory of its own. Only objects carry one.
    if (typeof via !== "object" || via === null) continue;
    const id = String(via.url ?? "").split("/").pop() ?? "";
    found.push({ id, severity: String(via.severity ?? "unknown"), package: name, title: String(via.title ?? "") });
  }
}

const blocking = found.filter((f) => FAIL_AT.has(f.severity) && !accepted.has(f.id));
const suppressed = found.filter((f) => accepted.has(f.id));
const stale = [...accepted.keys()].filter((id) => !found.some((f) => f.id === id));

for (const entry of suppressed) {
  const note = accepted.get(entry.id);
  console.log(`  accepted  ${entry.id}  ${entry.package}  (${entry.severity}) — revisit ${note?.revisit}`);
}

if (stale.length > 0) {
  // Not a failure: a stale entry means the advisory is gone, which is the outcome we
  // wanted. It is still noise, and noise in a suppression list is how the list stops
  // being read.
  console.log("");
  for (const id of stale) {
    console.log(`::warning::${id} is no longer reported — remove it from scripts/audit.mjs`);
  }
}

if (blocking.length > 0) {
  console.error("");
  console.error(`Dependency audit failed: ${blocking.length} advisory/advisories at high or above.`);
  for (const entry of blocking) {
    console.error(`  ${entry.severity.toUpperCase().padEnd(8)} ${entry.package}  ${entry.id}`);
    console.error(`           ${entry.title}`);
  }
  console.error("");
  console.error("Upgrade if a fix exists. If none does, add the advisory ID to ACCEPTED in");
  console.error("scripts/audit.mjs with the reasoning that makes it acceptable — not before.");
  process.exit(1);
}

const counts = report.metadata?.vulnerabilities ?? {};
console.log("");
console.log(
  `Dependency audit passed: nothing at high or above outside the accepted list ` +
    `(npm reports ${counts.critical ?? 0} critical, ${counts.high ?? 0} high, ` +
    `${counts.moderate ?? 0} moderate, ${counts.low ?? 0} low).`,
);
