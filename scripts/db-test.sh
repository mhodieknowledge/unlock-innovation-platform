#!/usr/bin/env bash
# Schema invariant suite. One script for CI and local use, for the same reason
# scripts/secret-scan.sh is: two checks that are meant to be the same check must
# be the same code.
#
# Fails on a FAIL line OR on a non-zero psql exit. An earlier local run used
# `grep -c PASS`, which counted 18 passes and reported success while the 19th
# assertion was raising — the count went down and nothing noticed. Counting
# successes is not the same as detecting failure.
set -euo pipefail

: "${DATABASE_URL:=${SUPABASE_DB_URL:-}}"
if [ -z "$DATABASE_URL" ]; then
  echo "Set DATABASE_URL (or SUPABASE_DB_URL) for this command only (invariant 11)." >&2
  exit 1
fi

total=0
for f in supabase/tests/*.sql; do
  out=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f" 2>&1) || {
    echo "$out" | sed 's/^psql:[^ ]* //'
    echo "::error::$f failed to run to completion." >&2
    exit 1
  }

  echo "── $f"
  echo "$out" | sed 's/^psql:[^ ]* NOTICE:  //'

  if echo "$out" | grep -q 'FAIL'; then
    echo "::error::An assertion in $f failed." >&2
    exit 1
  fi

  passes=$(echo "$out" | grep -c 'PASS' || true)
  if [ "$passes" -eq 0 ]; then
    echo "::error::No assertions ran in $f. The suite is vacuous." >&2
    exit 1
  fi
  total=$((total + passes))
done

echo "$total assertions passed."
