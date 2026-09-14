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

out=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/invariants.sql 2>&1) || {
  echo "$out" | sed 's/^psql:[^ ]* //'
  echo "::error::Schema invariant suite failed to run to completion." >&2
  exit 1
}

echo "$out" | sed 's/^psql:[^ ]* NOTICE:  //'

if echo "$out" | grep -q 'FAIL'; then
  echo "::error::A schema invariant assertion failed." >&2
  exit 1
fi

passes=$(echo "$out" | grep -c 'PASS' || true)
if [ "$passes" -eq 0 ]; then
  echo "::error::No assertions ran. The suite is vacuous." >&2
  exit 1
fi

echo "$passes schema invariant assertions passed."
