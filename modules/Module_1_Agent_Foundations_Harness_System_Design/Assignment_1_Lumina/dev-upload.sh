#!/usr/bin/env bash
# Upload one or more files into a Space and wait for the worker to finish with them.
#
#   ./dev-upload.sh eval/gold/corpus/*                 # every gold document
#   ./dev-upload.sh eval/gold/corpus/retrieval-basics.pdf
#   SPACE_ID=spc_abc ./dev-upload.sh notes.md          # into a named Space
#   SPACE_NAME='Fresh space' SPACE_ID= ./dev-upload.sh notes.md
#
# Env: AGENT (default http://localhost:8000), USER_ID (dev), TIMEOUT seconds (120).
set -euo pipefail

AGENT="${AGENT:-http://localhost:8000}"
USER_ID="${USER_ID:-dev}"
SPACE_NAME="${SPACE_NAME:-Q3 board pack}"
TIMEOUT="${TIMEOUT:-120}"
HDR=(-H "x-user-id: $USER_ID")

[ $# -gt 0 ] || { echo "usage: $0 <file> [file...]" >&2; exit 2; }

# Reuse the newest Space unless one is named; create it the first time.
space="${SPACE_ID:-}"
[ -n "$space" ] || space=$(curl -s "${HDR[@]}" "$AGENT/spaces" | jq -r '.spaces[0].spaceId // empty')
if [ -z "$space" ]; then
  space=$(curl -s -X POST "$AGENT/spaces" "${HDR[@]}" -H 'content-type: application/json' \
    -d "$(jq -nc --arg n "$SPACE_NAME" '{name:$n}')" | jq -r .spaceId)
  echo "created space $space ($SPACE_NAME)"
fi
echo "space $space"

ids=""
for f in "$@"; do
  out=$(curl -s -w '\n%{http_code} %{time_total}' -X POST "$AGENT/spaces/$space/documents" "${HDR[@]}" -F "file=@$f")
  body=$(printf '%s' "$out" | sed '$d')
  meta=$(printf '%s' "$out" | tail -1)
  docId=$(printf '%s' "$body" | jq -r '.docId // empty')
  printf '  %-32s %s in %ss  %s\n' "$(basename "$f")" "${meta%% *}" "${meta##* }" "${docId:-$body}"
  [ -n "$docId" ] && ids="$ids $docId"
done
[ -n "$ids" ] || { echo "nothing accepted" >&2; exit 1; }

# The 202 was a receipt. The work happens on the worker, so poll until every row is terminal.
deadline=$(( $(date +%s) + TIMEOUT ))
while :; do
  rows=$(curl -s "${HDR[@]}" "$AGENT/spaces/$space/documents")
  waiting=0
  for id in $ids; do
    st=$(printf '%s' "$rows" | jq -r --arg id "$id" '.documents[] | select(.docId==$id) | .status')
    case "$st" in indexed | failed) ;; *) waiting=$((waiting + 1)) ;; esac
  done
  [ "$waiting" -eq 0 ] && break
  if [ "$(date +%s)" -ge "$deadline" ]; then echo "timed out after ${TIMEOUT}s with $waiting still working"; break; fi
  sleep 1
done

for id in $ids; do
  printf '%s' "$rows" | jq -c --arg id "$id" '.documents[] | select(.docId==$id) | {title, status, pct, pages, chunks, error}'
done
