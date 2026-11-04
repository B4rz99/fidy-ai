import { Option } from "effect";
import type { OAuthCaller } from "../../../src/shell/oauth-agents/contract";
import { liveOAuthCredential } from "../../../src/shell/oauth-agents/operations";
import { prepareConsentStatus } from "../../consent/operations";

/** Caller facts select an exact credential; only native SQL can establish its current authority. */
export const resolveSnapshot = (
  input: Readonly<{
    db: D1Database;
    subject: OAuthCaller;
    current: number;
    execute: (statements: ReadonlyArray<D1PreparedStatement>) => ReadonlyArray<D1Result>;
  }>
): OAuthCaller | "unauthenticated" | "user_action_required" => {
  const subject = { ...input.subject, requiredScope: Option.none() };
  const credential = liveOAuthCredential({ subject, current: input.current });
  const rows = input.execute([
    input.db
      .prepare(`SELECT 1 AS live FROM ${credential.table} WHERE ${credential.predicate}`)
      .bind(...credential.bindings),
  ]);
  if (rows[0]?.results.length !== 1) return "unauthenticated";
  const consent = prepareConsentStatus({ db: input.db, userId: subject.userId });
  const status = Option.getOrThrow(
    consent.decode(input.execute([consent.statement])[0]?.results[0])
  );
  if (status === "Revoked") return "user_action_required";
  return status === "Granted" ? subject : "unauthenticated";
};
