/// <reference types="bun-types" />

import { edgeSecurityPolicy } from "./edge-security";

const expectedEdgePolicyDigest = "29afae1fa36144ed1d145b3a510061cb3939f90938534f9c9a4bc2a2fb343090";
const securityArtifacts = [
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
    new URL("../../apps/server/cloudflare/erasure/internal/checkpoint.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/erasure/internal/generation.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/erasure/internal/initialize.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/erasure/internal/operator-request.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/erasure/internal/restore-case.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/erasure/internal/restore.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/erasure/internal/registry-cutover.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/erasure/internal/registry-object.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/erasure/internal/registry-owner.ts", import.meta.url)
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
    new URL("../../apps/server/cloudflare/routing/runtime.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/shell/browser-transport/contract.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/erasure/runtime.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/erasure/internal/database.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/erasure/internal/measurement.ts", import.meta.url)
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
    new URL("../../apps/server/cloudflare/budgets/internal/budget-audit.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/budgets/internal/budget-latches.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/budgets/internal/bound-workspace.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/budgets/internal/planned-caps.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/budgets/internal/workspace-read.ts", import.meta.url)
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
    new URL(
      "../../apps/server/cloudflare/runtime/release-smoke/internal/database.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/migrations/0006_audit_media_index.sql", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/user-documents/operations.ts", import.meta.url)
  ).text(),
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
    new URL("../../apps/server/cloudflare/dashboard/internal/dashboard-timing.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/categories/internal/projection.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/transactions/internal/dashboard-read.ts", import.meta.url)
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
    new URL("../../apps/server/cloudflare/migrations/0004_connection_cleanup.sql", import.meta.url)
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
    new URL("../../apps/server/cloudflare/connections/internal/activation.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/connections/internal/grant.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/connections/internal/accounts.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/migrations/0003_connection_activation.sql",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/core-http/internal/http.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL(
      "../../apps/server/cloudflare/subscription/internal/payment-enrollment.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/oauth-agents/runtime.ts", import.meta.url)
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
    new URL("../../apps/server/cloudflare/web-session/internal/binding.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/web-session/internal/current-user.ts", import.meta.url)
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
    new URL(
      "../../apps/server/cloudflare/canonical-admission/internal/protection.ts",
      import.meta.url
    )
  ).text(),
  await Bun.file(
    new URL("../../apps/server/src/shell/sql-assertions/operations.ts", import.meta.url)
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
    new URL(
      "../../apps/server/cloudflare/categories/internal/canonical-category.ts",
      import.meta.url
    )
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
    new URL("../../apps/server/cloudflare/transactions/runtime.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/transactions/internal/recovery-alarm.ts", import.meta.url)
  ).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/ingestion/internal/publication-wake.ts", import.meta.url)
  ).text(),
  await Bun.file(new URL("../../apps/server/cloudflare/agent/contract.ts", import.meta.url)).text(),
  await Bun.file(
    new URL("../../apps/server/cloudflare/agent/internal/service.ts", import.meta.url)
  ).text(),
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
    new URL("../../apps/server/cloudflare/connections/internal/initiation.ts", import.meta.url)
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
    new URL(
      "../../apps/server/cloudflare/migrations/0002_connection_authorization.sql",
      import.meta.url
    )
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
