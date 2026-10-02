import type { CanonicalOperationId } from "~/core/canonical-operations/contract";
import type { HostedOperationWireName } from "~/shell/canonical-operations/operations";
import type { CatalogOperation } from "~/shell/canonical-catalog/contract";

/** Canonical operation declaration used by execution and confirmation boundaries. */
export type AgentOperationBinding = {
  readonly operation: CanonicalOperationId;
  /** Provider-safe encoding of `operation`; always `encodeHostedOperationWireName`'s output. */
  readonly wireName: HostedOperationWireName;
  readonly description: string;
  readonly canonicalParameters: CatalogOperation["input"];
  readonly success: CatalogOperation["success"];
  readonly failure: CatalogOperation["failure"];
  readonly policy: CatalogOperation["policy"];
};
