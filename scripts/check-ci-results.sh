#!/usr/bin/env bash
set -euo pipefail

# A conditional job may be skipped only when the successful detector explicitly
# selected false for it. Missing outputs, failures, and cancellations fail closed.
jq --exit-status '
  . as $jobs
  | ($jobs.changes.result == "success")
    and all($jobs | to_entries[];
      .key as $job
      | ($jobs.changes.outputs[$job] // "true") as $selected
      | if $selected == "false" then .value.result == "skipped"
        elif $selected == "true" then .value.result == "success"
        else false end
    )
' <<<"${RESULTS:?RESULTS is required}" >/dev/null || {
  echo "Required jobs did not match the change plan (or change detection failed)." >&2
  exit 1
}
