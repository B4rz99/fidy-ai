/// <reference types="bun-types" />

import { edgeSecurityPolicy } from "./edge-security";

const expectedEdgePolicyDigest = "17e919eb8689a8c40c23e52df9798f70a670718f329137cc5b1a709b595cefda";

const securityArtifacts = [
  ...(await Promise.all(
    [
      "../../apps/server/cloudflare/agent/internal/local-compaction.ts",
      "../../apps/server/cloudflare/release-fixture/operations.ts",
      "../../apps/server/cloudflare/release-fixture/internal/payments.ts",
      "../../apps/server/cloudflare/release-fixture/contract.ts",
      "../../apps/server/src/shell/pro-grants/operations.ts",
      "../../apps/server/src/shell/pro-grants/contract.ts",
      "../../apps/server/cloudflare/beta-pro/contract.ts",
      "../../apps/server/cloudflare/beta-pro/runtime.ts",
      "../../apps/server/cloudflare/beta-pro/operations.ts",
      "../../apps/server/cloudflare/maintenance/internal/beta-registry.ts",
      "../../apps/server/cloudflare/beta-pro/internal/user.ts",
      "../../scripts/pro/main.ts",
      "../../scripts/pro/runtime.ts",
      "../../apps/server/cloudflare/agent/internal/local-inference.ts",
      "../../apps/server/cloudflare/release-isolation/contract.ts",
      "../../apps/server/cloudflare/release-isolation/internal/deployment.ts",
      "../../apps/server/cloudflare/release-isolation/internal/request-proof.ts",
      "../../apps/server/cloudflare/release-isolation/internal/performance-receipt.ts",
      "../../apps/server/cloudflare/transactions/internal/performance-receipt.ts",
      "./native-fixture-signer.ts",
      "./native-fixture-upload.json",
      "./native-pairing-upload.json",
      "./native-upload-recovery.ts",
      "./native-retained-provider.json",
      "./native-fallback-probe.ts",
      "./native-fixture-plan.ts",
      "./native-smoke-consumer-recovery.ts",
      "../../.github/workflows/native-fixture-successor-plan.yml",
      "../../.github/workflows/native-fixture-workflow-recovery-plan.yml",
      "../../.github/workflows/native-fixture-workflow-recovery-apply.yml",
      "./native-workflow-recovery-plan.ts",
      "./native-workflow-recovery-apply.ts",
      "../../scripts/infra-performance/canonical-fixture/successor_source.py",
      "../../scripts/infra-performance/canonical-fixture/successor_artifacts.py",
      "../../scripts/infra-performance/canonical-fixture/pinned_storage.py",
      "../../scripts/infra-performance/canonical-fixture/successor_resume.py",
      "../../scripts/infra-performance/canonical-fixture/successor_reseal.py",
      "../../scripts/infra-performance/canonical-fixture/successor_partial.py",
      "../../scripts/infra-performance/canonical-fixture/successor_workflow_proof.py",
      "./native-fallback-recovery.ts",
      "./production-release.ts",
      "../../scripts/infra-performance/canonical-fixture/fallback_stage.py",
      "../../scripts/infra-performance/canonical-fixture/interrupted_upload.py",
      "../../scripts/infra-performance/canonical-fixture/unsealed_stage.py",
      "../../scripts/infra-performance/canonical-fixture/staged_application.py",
      "../../scripts/infra-performance/canonical-fixture/pairing_stage.py",
      "../../apps/server/cloudflare/fixture-fallback-core.ts",
      "../../apps/server/cloudflare/fixture-fallback-ingress.ts",
      "../../apps/server/cloudflare/release-isolation/runtime.ts",
      "../../apps/server/cloudflare/runtime/release-smoke/internal/platform.ts",
      "./installed-verification-revision.ts",
      "./native-acceptance.ts",
      "./native-erasure.ts",
      "./native-erasure-continuation.ts",
      "./native-erasure-evidence.ts",
      "./native-application-bindings.ts",
      "./native-application-resources.ts",
      "./native-application.ts",
      "./native-deployed-access.ts",
      "./native-deployed-edge.ts",
      "./native-deployed-graph.ts",
      "./native-deployed-web.ts",
      "./native-edge.ts",
      "./native-fleet-pilot.ts",
      "./native-ten-fleet.ts",
      "./native-ten-release.ts",
      "../../.github/workflows/native-transaction-cohort.yml",
      "../../scripts/infra-performance/canonical-fixture/cohort-bridge.ts",
      "../../scripts/infra-performance/canonical-fixture/cohort.py",
      "../../scripts/infra-performance/canonical-fixture/cohort_runner.py",
      "../../scripts/infra-performance/canonical-fixture/hosted.py",
      "../../scripts/infra-performance/canonical-fixture/installation.py",
      "../../scripts/infra-performance/canonical-fixture/native_budget.py",
      "../../scripts/infra-performance/canonical-fixture/native_custody.py",
      "../../scripts/infra-performance/canonical-fixture/protected_cohort.py",
      "../../scripts/infra-performance/canonical-fixture/native_smoke.py",
      "../../scripts/infra-performance/canonical-fixture/qualified_release.py",
      "../../scripts/infra-performance/hosted-browser/origin.mjs",
      "../../scripts/infra-performance/hosted-browser/contracts.ts",
      "../../scripts/infra-performance/hosted-browser/captured-profile.mjs",
      "../../scripts/infra-performance/hosted-browser/native-accounting.ts",
      "../../scripts/infra-performance/hosted-browser/native-smoke.ts",
      "../../scripts/infra-performance/hosted-browser/scoped-correction.mjs",
      "../../scripts/infra-performance/deployed-fleet/ten-source.sh",
      "../../scripts/infra-performance/deployed-fleet/ten.py",
      "../../scripts/infra-performance/deployed-fleet/pilot.py",
      "../../scripts/infra-performance/deployed-fleet/observations.py",
      "./native-graph.ts",
      "./native-host-plan.ts",
      "./native-canonical-domains.ts",
      "./native-canonical-signup.ts",
      "../../apps/server/cloudflare/directory/internal/signup-observation.ts",
      "../../scripts/infra-performance/canonical-fixture/canonical_activity.py",
      "../../scripts/infra-performance/canonical-fixture/canonical_host_source.py",
      "./native-incumbent-fence.ts",
      "./native-plan-diagnostics.ts",
      "./native-provider-list.ts",
      "./native-recovery-identity.ts",
      "./resource-failure.ts",
      "./native-release-smoke.ts",
      "./release-controller.ts",
      "./release-rollback.ts",
    ].map((path) => Bun.file(new URL(path, import.meta.url)).text())
  )),
  await Bun.file(
    new URL("../../apps/server/cloudflare/transactions/internal/sqlite-privacy.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/user-store/internal/uncertainty.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/erasure-store/internal/settlement.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/erasure/internal/native-evidence.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/erasure/internal/native-scope.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/erasure-store/internal/local-purge.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/user-store/internal/erasure-purge.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/ingestion/internal/original-writers.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/ingestion/internal/drain-originals.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/agent/internal/confirmation-description.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/canonical-admission/internal/local-batch-plans.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/canonical-admission/internal/local-hosted-batch.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/directory/internal/erasure.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/erasure-store/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/erasure-store/runtime.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/erasure-store/internal/cases.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/erasure/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/user-store/internal/erasure-handoff.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/user-store/internal/erasure-request.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/connections/internal/sqlite-activation.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/connections/internal/sqlite-browser.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/connections/internal/sqlite-connections.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/connections/internal/sqlite-retention.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/connections/internal/synchronization.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/user-store/internal/connection-schema.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/cli/src/direct-client/internal/operator-access.ts", import.meta.url)
  ).text(),
  await Bun.file(new URL("../../apps/cli/src/sample-review/operations.ts", import.meta.url)).text(),
  await Bun.file(new URL("../../apps/cli/src/sample-review/runtime.ts", import.meta.url)).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/ingestion/internal/sample-authority.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/ingestion/internal/sample-operator.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/ingestion/internal/sample-review.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/ingestion/internal/sample-publication.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/ingestion/internal/sample-response.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/user-store/internal/sample-schema.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/directory/internal/email-capacity.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/ingestion/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/ingestion/email-worker.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/ingestion/internal/email-capacity.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/ingestion/internal/local-document.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/ingestion/internal/local-email.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/ingestion/internal/local-retention.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/ingestion/internal/local-review.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/ingestion/internal/local-review-edit.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/ingestion/internal/local-review-list.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/ingestion/internal/local-review-material.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/ingestion/internal/local-review-snapshot.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/ingestion/internal/local-statement-decision.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/ingestion/internal/local-statement-work.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/private-objects/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/user-store/internal/ingestion-schema.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/email-authentication/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/queue/internal/dispatch.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/maintenance/internal/cadence.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/directory/internal/login-email.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/email-authentication/internal/login-admission.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/email-authentication/internal/login-completion.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/email-authentication/internal/login-delivery.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/categories/internal/oauth-review.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/dashboard/internal/oauth-review.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/directory/schema/credential-schema.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/oauth-agents/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/oauth-agents/internal/approval.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/oauth-agents/internal/bootstrap.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/oauth-agents/internal/discovery.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/oauth-agents/internal/exchange.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/oauth-agents/internal/native-access.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/oauth-agents/internal/native-admission.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/oauth-agents/internal/native-browser.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/oauth-agents/internal/native-directory.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/oauth-agents/internal/native-management.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/oauth-agents/internal/native-operation.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/oauth-agents/internal/native-registration.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/oauth-agents/internal/native-token.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/oauth-agents/internal/review.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/oauth-agents/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/oauth-confirmation/internal/local.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/oauth-confirmation/internal/native-disclosure.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/oauth-confirmation/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/subscription/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/tokens/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/tokens/internal/native-claim.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/tokens/internal/native-expiry.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/tokens/internal/native-grants.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/tokens/internal/native-management.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/tokens/internal/native-pairing.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/tokens/internal/native-routes.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/tokens/internal/pat-manual.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/tokens/internal/pat-pairing.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/transactions/internal/oauth-review.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/user-store/internal/credential-schema.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/shell/tokens/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/directory/internal/recovery-rotation.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/directory/internal/replacement.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/directory/internal/support.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/email-authentication/internal/local-mailbox.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/email-authentication/internal/local-replacement.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/email-authentication/internal/native-mail-delivery.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/email-authentication/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/email-authentication/runtime.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/identity/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/recovery/internal/local-rotation.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/recovery/internal/local-support.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/recovery/internal/support-recovery.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/recovery/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/user-store/internal/identity-change.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/web-authentication/operations.ts", import.meta.url)
  ).text(),

  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/canonical-admission/internal/local-batch.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/canonical-operations/internal/local-owners.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/canonical-operations/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/categories/internal/sqlite-keyword.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/recurring-plans/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/recurring/internal/sqlite-series.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/recurring/internal/evaluation.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/recurring-plans/internal/sqlite-plans.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/recurring-plans/internal/store.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/recurring-plans/internal/mutation.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/transactions/internal/planning-read.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/transactions/internal/recurring-query.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/browser-login/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/browser-login/internal/local-pairing.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/browser-login/internal/proof.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/browser-login/internal/pairing.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/browser-login/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/directory/internal/admission.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/directory/internal/channel.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/directory/internal/expiry.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/directory/internal/pairing.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/directory/internal/provider.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/directory/internal/reservations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/directory/internal/whatsapp.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/provider-authentication/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/provider-authentication/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/provider-authentication/runtime.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/provider-authentication/internal/callback.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/provider-authentication/internal/configuration.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/provider-authentication/internal/google-token.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/provider-authentication/internal/microsoft-token.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/provider-authentication/internal/start.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/provider-authentication/internal/token-contract.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/user-store/internal/registration.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/user-store/internal/bootstrap.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/user-store/internal/browser-session.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/directory/internal/external-events.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/directory/schema/external-events.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/whatsapp/internal/native-delivery.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/whatsapp/internal/registered-send.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/subscription/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/subscription/internal/enrollment-policy.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/subscription/internal/enrollment-session.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/subscription/internal/local-billing-admission.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/subscription/internal/local-billing-work.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/subscription/internal/local-enrollment-form.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/subscription/internal/local-enrollment-submit.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/subscription/internal/local-renewal.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/subscription/internal/native-enrollment.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/user-store/internal/billing-admission-schema.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/subscription/internal/native-billing.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/user-store/internal/billing-callback-schema.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/subscription/internal/billing-settlement.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/subscription/internal/billing-workflow.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/subscription/internal/wompi-event.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/ingestion/internal/native-forwarding.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/user-store/internal/external-event-schema.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/whatsapp/internal/ingress.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/web-session/internal/credentials.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/recovery/internal/material.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/subscription/internal/local-cancellation.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/maintenance/internal/watchdog.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/budgets/internal/sqlite-dispatch.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/budgets/internal/sqlite-planning.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/budgets/internal/sqlite-workspace.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/dashboard/internal/sqlite-dashboard.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/transactions/internal/dashboard-query.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/transactions/internal/sqlite-aggregate.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/tokens/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/tokens/internal/native-pat.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/transactions/internal/sqlite-capture.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/transactions/internal/sqlite-corrections.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/canonical-admission/internal/request-input.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/canonical-admission/internal/responses.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/canonical-admission/internal/local-mutation.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/categories/internal/native-categorization.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/core/categories/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/core/categories/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/core/categories/internal/taxonomy.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/core/categories/internal/taxonomy-release.json", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/shell/categories/internal/query.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/operator-access/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/subscription/internal/publish-price.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/subscription/internal/pricing-object.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/erasure/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/erasure/internal/generation.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/erasure/internal/operator-request.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/erasure/internal/registry-object.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/erasure/internal/registry-storage.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/erasure/internal/registry-transport.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/erasure/internal/registry-value.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/shell/browser-transport/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/erasure/runtime.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/budgets/internal/workspace-encoding.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/budgets/internal/budget-row.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/core/budgets/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/budgets/internal/budget-report.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/budgets/internal/monthly-cash-flow.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/transactions/internal/dashboard-projection.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(new URL("../../patches/alchemy@2.0.0-beta.80.patch", import.meta.url)).text(),
  await Bun.file(new URL("./smoke-exchange.ts", import.meta.url)).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/dashboard/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/dashboard/internal/dashboard.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/dashboard/internal/dashboard-mutation.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/dashboard/internal/dashboard-view.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/budgets/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/canonical-admission/internal/response-timing.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/connections/internal/retention.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/connections/internal/cleanup.ts", import.meta.url)
  ).text(),

  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/bancolombia-authentication/internal/token-lifecycle.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/bancolombia-authentication/internal/activation.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/connections/internal/grant.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/core-http/internal/http.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/oauth-agents/internal/management.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/resource-admission/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/resource-admission/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/web-session/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/web-session/internal/authentication.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/canonical-admission/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/core/connections/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/canonical-admission/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/directory/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/directory/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/directory/runtime.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/user-store/runtime.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/user-store/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/runtime/sqlite/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/secret-material/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/erasure-store/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/maintenance/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/maintenance/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/maintenance/runtime.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/subscription/runtime.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/runtime/sqlite/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/transactions/internal/sqlite-history.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/transactions/internal/effective-transaction.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/transactions/internal/transaction-history.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/transactions/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/categories/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/quotas/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/web-session/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/shell/web-session/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/shell/access-tier/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/shell/identity/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/shell/subscription/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/mcp/native-confirmation.ts", import.meta.url)
  ).text(),
  await Bun.file(new URL("../../apps/server/cloudflare/mcp/runtime.ts", import.meta.url)).text(),
  ...(await Promise.all(
    [
      "agent/internal/local-turn-store.ts",
      "agent/internal/local-turn.ts",
      "agent/internal/local-inference.ts",
      "agent/internal/tool-reply.ts",
      "ingestion/internal/local-statement-scope.ts",
      "agent/internal/local-tool.ts",
      "agent/internal/local-recovery.ts",
      "agent/internal/local-compaction.ts",
      "agent/internal/local-history.ts",
      "agent/internal/local-challenge.ts",
      "agent/internal/local-whatsapp.ts",
      "agent/internal/local-channel-delivery.ts",
      "agent/internal/local-channel-receipt.ts",
      "agent/internal/local-document-reply.ts",
      "insights/internal/local-reminder.ts",
      "insights/internal/local-reminder-choice.ts",
      "insights/internal/local-reminder-attention.ts",
      "insights/internal/local-disclosure.ts",
      "insights/internal/local-reminder-attention.ts",
      "insights/internal/reminder-claim.ts",
      "resource-admission/internal/provider-allowance.ts",
      "whatsapp/internal/native-delivery.ts",
      "user-store/internal/hosted-schema.ts",
    ].map((relative) =>
      Bun.file(new URL("../../apps/server/cloudflare/" + relative, import.meta.url)).text()
    )
  )),
  JSON.stringify(edgeSecurityPolicy),
  await Bun.file(new URL("alchemy.run.ts", import.meta.url)).text(),
  await Bun.file(new URL("alchemy.storage.ts", import.meta.url)).text(),
  await Bun.file(new URL("storage-installation.ts", import.meta.url)).text(),
  await Bun.file(new URL("storage-release.ts", import.meta.url)).text(),
  await Bun.file(new URL("native-storage-resources.ts", import.meta.url)).text(),
  await Bun.file(new URL("native-storage-release.ts", import.meta.url)).text(),
  await Bun.file(
    new URL("../../.github/workflows/native-storage-release.yml", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/storage-bootstrap/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/storage-bootstrap/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/directory/schema/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/subscription/pricing/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(new URL("worker-observability.ts", import.meta.url)).text(),
  await Bun.file(new URL("../../apps/server/cloudflare/public-worker.ts", import.meta.url)).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/bancolombia-authentication/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/bancolombia-authentication/operations.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/bancolombia-authentication/runtime.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/src/shell/outbound-http/internal/bancolombia-http.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/shell/outbound-http/internal/transport.ts", import.meta.url)
  ).text(),

  await Bun.file(
    new URL("../../apps/server/cloudflare/release-smoke-worker.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/runtime/release-smoke/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/runtime/release-smoke/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/runtime/release-smoke/runtime.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/release-isolation/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/core-http/runtime.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/outbound-http/runtime.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/bancolombia-sandbox/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/bancolombia-sandbox/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/shell/processing-consent/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/shell/processing-consent/runtime.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/shell/connections/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(new URL("../../apps/server/cloudflare/core-worker.ts", import.meta.url)).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/transactions/internal/recovery-alarm.ts", import.meta.url)
  ).text(),
  await Bun.file(new URL("../../apps/server/cloudflare/agent/contract.ts", import.meta.url)).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/connections/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/connections/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/connections/internal/institution-registration.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/connections/runtime.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/connections/internal/browser.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/connections/internal/authorization.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/connections/internal/erasure.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/shell/connections/runtime.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/shell/subscription/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/shell/subscription/runtime.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/anonymous-admission/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/anonymous-admission/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/runtime/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/runtime/operations.ts", import.meta.url)
  ).text(),
  await Bun.file(new URL("../../apps/web/cloudflare/production/_headers", import.meta.url)).text(),
  await Bun.file(
    new URL("../../apps/web/cloudflare/production/_redirects", import.meta.url)
  ).text(),
  await Bun.file(new URL("../../apps/site/public/_headers", import.meta.url)).text(),
  await Bun.file(new URL("../../apps/site/public/_redirects", import.meta.url)).text(),
  await Bun.file(new URL("../../apps/site/astro.config.ts", import.meta.url)).text(),
  await Bun.file(new URL("../../apps/site/cloudflare/worker.ts", import.meta.url)).text(),
  await Bun.file(new URL("../../apps/site/scripts/build-headers.ts", import.meta.url)).text(),
];

export const edgePolicyDigest = securityArtifacts
  .reduce(
    (hasher, artifact) => hasher.update(`${artifact.length}:`).update(artifact),
    new Bun.CryptoHasher("sha256")
  )
  .digest("hex");

export const edgePolicyIsReviewed = edgePolicyDigest === expectedEdgePolicyDigest;

if (import.meta.main && !edgePolicyIsReviewed) {
  await Bun.write(Bun.stderr, "Desired edge policy differs from the reviewed manifest.\n");
  process.exitCode = 1;
}
