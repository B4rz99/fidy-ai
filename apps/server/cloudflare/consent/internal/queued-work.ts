import { protectConsentStatement } from "../../../src/shell/consent/operations";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import type { QueuedConsentAction } from "../contract";

/** Recheck the exact native item and stable User together with its historical Consent. */
export const protectQueuedStatement = (input: QueuedConsentAction): OwnedStatement =>
  protectConsentStatement({
    subject: { _tag: "User", userId: input.userId },
    requirement: "granted",
    statement: {
      sql: `${input.statement.sql} AND EXISTS (SELECT 1 FROM (${input.queued.sql}) queued_processing WHERE queued_processing.user_id = ?)`,
      params: [...input.statement.params, ...input.queued.params, input.userId],
    },
  });
