import { Schema } from "effect";
import { UserId } from "../../src/core/identity/contract";
import {
  ProCommand,
  ProGrantEntry,
  ProGrantFailureReason,
  ProOperator,
  maximumProGrants,
} from "../../src/shell/pro-grants/contract";
import type { AuthoritativeStoreEnvironment } from "../sqlite-store/contract";
import type { RecoveryAdmissionEnvironment } from "../recovery-activation/contract";

export const ProGrantOperatorRequest = Schema.Struct({
  command: ProCommand,
  operator: ProOperator,
});
export type ProGrantOperatorRequest = typeof ProGrantOperatorRequest.Type;
export const ProGrantOperatorReply = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("success"),
    entries: Schema.Array(ProGrantEntry).check(Schema.isMaxLength(maximumProGrants)),
  }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: ProGrantFailureReason,
    candidates: Schema.Array(UserId).check(Schema.isMaxLength(2)),
  }),
]);
export type ProGrantOperatorReply = typeof ProGrantOperatorReply.Type;
export type ProGrantOperatorBinding = Readonly<{
  execute: (candidate: unknown) => Promise<unknown>;
}>;
export type ProGrantOperatorEnvironment = AuthoritativeStoreEnvironment &
  RecoveryAdmissionEnvironment &
  Partial<
    Readonly<{
      ERASURE_BUCKET: R2Bucket;
      RECOVERY_ISOLATION: string;
    }>
  >;
