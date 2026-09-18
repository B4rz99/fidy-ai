import type { CanonicalOperationId } from "~/core/canonical-operations/contract";
import type { HostedOperationWireName } from "~/shell/_shared/hosted-operation-bindings";
import type { CatalogOperation } from "~/shell/_shared/operation-catalog";

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
