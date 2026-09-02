#!/usr/bin/env bash
# Delete the ClawSweeper label families that the signal comment policy no
# longer writes (see docs/pr-review-comments.md#signal-only-comment-policy-hamelyn).
#
# Run it AFTER the fork change is live on main; the previous code recreates
# any missing owned label on its next label sync.
#
#   scripts/retire-hamelyn-labels.sh                 # dry-run: prints what it would delete
#   scripts/retire-hamelyn-labels.sh --execute       # deletes with the gh CLI
#   REPO=Hamelyn-SL/other scripts/retire-hamelyn-labels.sh --execute
#
# Deleting a label removes it from every issue and PR; the "labeled" timeline
# events stay, so history is not lost. Human-owned families (size/*, surface:*,
# app:*, area:*, mk:*, reporter:*, triage:*, origin:*, P0-P3) are never touched.
set -euo pipefail

REPO="${REPO:-Hamelyn-SL/hamelyn-serverless}"
EXECUTE=0
for arg in "$@"; do
  case "$arg" in
    --execute) EXECUTE=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# Labels ClawSweeper keeps writing under the signal policy.
KEEP_REGEX='^(clawsweeper:needs-product-decision|clawsweeper:needs-security-review|clawsweeper:human-review|clawsweeper:manual-only|clawsweeper:autofix|clawsweeper:automerge)$'
# Families that are retired. Kept in sync with isRetiredLabelUnderSignalPolicy
# in src/review-policy.ts.
RETIRE_REGEX='^(rating: |issue-rating: |impact:|merge-risk: |proof: |status: |maturity:|mantis: |clawsweeper:|feature: ✨ showcase$|triage: needs-real-behavior-proof$)'

# `while read` instead of mapfile: this runs from macOS (bash 3.2) as well.
to_delete=()
while IFS= read -r label; do
  [ -n "$label" ] || continue
  if [[ "$label" =~ $KEEP_REGEX ]]; then continue; fi
  if [[ "$label" =~ $RETIRE_REGEX ]]; then to_delete+=("$label"); fi
done < <(gh label list --repo "$REPO" --limit 500 --json name --jq '.[].name' | sort)

if [ "${#to_delete[@]}" -eq 0 ]; then
  echo "Nothing to delete in $REPO."
  exit 0
fi

echo "Labels to delete in $REPO (${#to_delete[@]}):"
printf '  %s\n' "${to_delete[@]}"

if [ "$EXECUTE" -ne 1 ]; then
  echo
  echo "Dry-run. Re-run with --execute to delete them."
  exit 0
fi

failed=0
for label in "${to_delete[@]}"; do
  if gh label delete "$label" --repo "$REPO" --yes >/dev/null 2>&1; then
    echo "deleted: $label"
  else
    echo "FAILED: $label" >&2
    failed=$((failed + 1))
  fi
done
echo "Done: $(( ${#to_delete[@]} - failed )) deleted, $failed failed."
[ "$failed" -eq 0 ]
