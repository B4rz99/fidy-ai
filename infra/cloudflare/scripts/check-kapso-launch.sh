#!/usr/bin/env bash
set -euo pipefail

# This is an evidence/completeness check, not a remote attestation of Kapso's dashboard.
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
evidence=${1:-"$root/docs/operations/kapso-launch-evidence.json"}
policy=$(grep -o 'policy-[0-9-]*[a-z-]*' "$root/apps/web/src/features/public-site/legal/policy.html" | head -n 1)
onboarding=$(grep -o 'onboarding-[0-9-]*-[a-z-]*' "$root/apps/server/src/shell/consent/current-disclosure.ts" | head -n 1)

if [[ ! -f "$evidence" ]] || ! jq -e --arg policy "$policy" --arg onboarding "$onboarding" '
  def verified: type == "string" and length > 0 and . != "PENDING";
  (.reviewedAt | verified) and (.reviewer | verified) and
  (.contractingEntity | verified) and (.termsEvidence | verified) and
  (.dpaEvidence | verified) and (.subprocessorsEvidence | verified) and
  (.transcriptProvider | verified) and (.transcriptConfigurationEvidence | verified) and
  (.retentionDays | type == "number" and . >= 1 and . <= 30 and . == floor) and
  (.retentionEvidence | verified) and (.unusedFeaturesEvidence | verified) and
  ([.unusedFeatures.agents, .unusedFeatures.models, .unusedFeatures.workflows,
    .unusedFeatures.replay, .unusedFeatures.sandbox, .unusedFeatures.mcp,
    .unusedFeatures.analytics] | all(. == "disabled" or . == "justified")) and
  (.deletionTestEvidence | verified) and
  .policyRevision == $policy and .onboardingRevision == $onboarding
' "$evidence" >/dev/null 2>&1; then
  echo 'check=kapso_launch category=kapso_launch_not_verified' >&2
  exit 1
fi

echo 'Kapso launch evidence is complete; verify provider settings still match before enabling traffic.'
