#!/usr/bin/env bash
# Recover the original protected trial only. The admission artifact was sealed before first signup.
set -euo pipefail
umask 077
[[ "$FLEET_SOURCE_RUN" =~ ^[1-9][0-9]{0,19}$ ]]
base="repos/$GITHUB_REPOSITORY/actions"
run="$FLEET_SOURCE_RUN"
source=$(gh api "$base/runs/$run" | jq -er --arg repo "$GITHUB_REPOSITORY" '
  select(.repository.full_name==$repo and .event=="workflow_dispatch" and .head_branch=="trunk" and
  .path==".github/workflows/native-storage-release.yml" and .run_attempt==1 and
  (.conclusion=="failure" or .conclusion=="cancelled" or .conclusion=="timed_out")) | .head_sha')
[[ "$source" =~ ^[0-9a-f]{40}$ ]]
git merge-base --is-ancestor "$source" HEAD
jobs=$(gh api "$base/runs/$run/attempts/1/jobs")
completed=$(jq -er '.jobs[]|select(.name=="release")|.completed_at|fromdateiso8601' <<< "$jobs")
jq -e '
  [.jobs[] | select(.name=="release") | .steps[] |
  select(.name=="Measure ten hosted fleet Users" and .started_at!=null and
    (.conclusion=="failure" or .conclusion=="cancelled" or .conclusion=="timed_out" or .conclusion=="success"))] | length==1' <<< "$jobs" > /dev/null
artifacts=$(gh api "$base/runs/$run/artifacts?per_page=100")
for name in "native-storage-release-$run" "native-ten-admission-$run"; do
  row=$(jq -ce --arg name "$name" '[.artifacts[]|select(.name==$name)] | if length==1 then .[0] elif length==0 then {} else error("ambiguous source") end' <<< "$artifacts")
  [[ "$row" != '{}' ]] || continue
  artifact=$(jq -er --arg sha "$source" --arg run "$run" 'select(.expired==false and .size_in_bytes<=1048576 and
    .workflow_run.head_sha==$sha and (.workflow_run.id|tostring)==$run) | .id' <<< "$row")
  digest=$(jq -er '.digest|capture("^sha256:(?<hash>[0-9a-f]{64})$").hash' <<< "$row")
  zip="$RUNNER_TEMP/fleet-source.zip"
  gh api "$base/artifacts/$artifact/zip" > "$zip"
  echo "$digest  $zip" | sha256sum --check --status
  files=$(unzip -Z1 "$zip")
  if ! grep -Fxq native-verification.json.fleet <<< "$files" || ! grep -Fxq native-fleet-meter.jsonl <<< "$files"; then
    continue
  fi
  unzip -p "$zip" native-verification.json.fleet > "$SMOKE_ATTESTATION_FILE.fleet"
  unzip -p "$zip" native-fleet-meter.jsonl > "$RUNNER_TEMP/fleet-source-meter.jsonl"
  jq -n --arg run "$run" --arg artifact "$artifact" --arg sha "$source" --arg zip "$digest" --argjson finished "$completed" \
    '{runId:$run,artifactId:$artifact,sourceRevision:$sha,archiveSha256:$zip,sourceFinishedAt:$finished}' > "$RUNNER_TEMP/fleet-provenance.json"
  echo "FLEET_SOURCE_REVISION=$source" >> "$GITHUB_ENV"
  exit 0
done
exit 1
