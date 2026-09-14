#!/usr/bin/env bash
# Secret scan. Invariant 11: never commit a secret; this repository is public.
#
# ONE script, used by CI and by hand, so the two cannot drift. They did drift
# once: a local ad-hoc grep passed while CI's slightly different pattern failed,
# and two commits went out red. A shared script is the fix.
#
# Patterns cover the credential shapes this project actually handles, so the check
# needs no third-party action and no token to run.
#
# Usage:
#   scripts/secret-scan.sh            scan tracked files
#   scripts/secret-scan.sh --staged   scan the staging area (pre-commit)
set -euo pipefail

MODE="${1:-}"

# Credential shapes. Each is specific enough not to fire on prose.
PATTERNS=(
  'eyJhbGciOi'                        # JWT header (Supabase anon / service_role)
  'cfut_[A-Za-z0-9]{20}'              # Cloudflare API token
  'gsk_[A-Za-z0-9]{20}'               # Groq
  'csk-[a-z0-9]{20}'                  # Cerebras
  'xkeysib-[a-f0-9]{32}'              # Brevo
  'GOCSPX-'                           # Google OAuth client secret
  'AIzaSy[A-Za-z0-9_-]{20}'           # Google API key
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  # A Postgres DSN carrying a password. The character classes deliberately
  # exclude < and > so documented PLACEHOLDERS such as
  # postgresql://postgres.<ref>:<password>@host do not fire, while a real
  # credential still does.
  'postgres(ql)?://[^:<>[:space:]]+:[^@<>[:space:]]+@'
)

JOINED=$(IFS='|'; echo "${PATTERNS[*]}")

# Excluded because they legitimately CONTAIN the patterns:
#   this script defines them
#   package-lock.json carries base64 integrity hashes that can look like keys
#
# .github/workflows/ci.yml USED to be excluded wholesale, which was a hole: a real
# credential pasted into the one file CI runs would have been the one place the scan
# could not see. The workflows now pass a throwaway database password through
# PGPASSWORD instead of inlining it in a DSN, so nothing there matches and nothing
# needs excluding.
EXCLUDES=(
  ':!package-lock.json'
  ':!*.lock'
  ':!scripts/secret-scan.sh'
)

if [ "$MODE" = "--staged" ]; then
  GREP_ARGS=(--cached)
  WHAT="staged changes"
else
  GREP_ARGS=()
  WHAT="tracked files"
fi

if git grep "${GREP_ARGS[@]}" -nIE "$JOINED" -- "${EXCLUDES[@]}"; then
  echo ""
  echo "::error::Possible secret in ${WHAT}. Rotate it immediately and treat it as compromised, regardless of how quickly it is removed (SECURITY.md 6)."
  exit 1
fi

# A filled-in .env must never be tracked. The template is the only permitted
# .env* file in the tree.
if git ls-files --error-unmatch '.env' '.env.local' '.env.production' 2>/dev/null; then
  echo "::error::A .env file is tracked. Remove it and rotate everything it contained."
  exit 1
fi

echo "No secret material in ${WHAT}."
