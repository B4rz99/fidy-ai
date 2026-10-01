import type { AuditCredentialOperation } from "~/shell/audit/contract";

/** Canonical child calls eligible to advance PAT activity; batch envelopes have separate accountability. */
export type AuditedPATOperation = Exclude<
  AuditCredentialOperation,
  "operations.executeAtomicBatch"
>;
