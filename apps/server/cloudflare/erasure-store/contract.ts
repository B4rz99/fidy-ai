import { UserId } from "../../src/core/identity/contract";
import { type ErasureClass, ErasureReference } from "../../src/core/erasure/contract";
import { Data, type Option, Schema } from "effect";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";

export class ErasureUnavailable extends Data.TaggedError("ErasureUnavailable")<{
  readonly cause: Option.Option<unknown>;
}> {}

export type ErasureScope = Readonly<{ userId: string; reference: string }>;

export type ErasureProjection = Readonly<{
  id: string;
  dataClass: ErasureClass;
  dependencies: ReadonlyArray<string>;
  candidates: (userId: string) => OwnedStatement;
  quiescence: ErasureQuiescence;
  remove: (
    selection: ErasureScope & Readonly<{ rowRefsJson: string }>
  ) => ReadonlyArray<OwnedStatement>;
  remaining: (userId: string) => OwnedStatement;
}>;

export type ErasureQuiescence = Data.TaggedEnum<{
  Synchronous: {};
  Durable: {
    readonly select: (input: Readonly<{ userId: string; current: number }>) => OwnedStatement;
  };
}>;

export const ErasureQuiescence = Data.taggedEnum<ErasureQuiescence>();

export const ErasureHandoff = Schema.Struct({
  userId: UserId,
  reference: ErasureReference,
  requestedAtMs: Schema.Int.check(Schema.isGreaterThan(0)),
});

export const registerCaseUrl = "https://erasure.invalid/case/register";

export const confirmHandoffUrl = "https://user.invalid/erasure/confirm";

export const participantFenceUrl = "https://owner.internal/erasure/fence";

export const resendScopeLimit = 16;

export const resendScopePageStatus = 206;

export const resendScopeCursor = "fidy-erasure-resend-after";

export const ResendScopePage = Schema.Array(
  Schema.Struct({
    work_id: Schema.String.check(Schema.isUUID()),
    requested_at_ms: Schema.Int.check(Schema.isGreaterThan(0)),
  })
).check(Schema.isMinLength(1), Schema.isMaxLength(resendScopeLimit));

export const LocalCustody = Schema.Struct({
  whatsapp: Schema.Literals([0, 1]),
  resend: Schema.Literals([0, 1]),
  wompi: Schema.Literals([0, 1]),
});

export const erasedUserUrl = "https://erasure.invalid/case/empty-user";

export const localDrainUrl = "https://user.invalid/erasure/drain";

export const localPurgeUrl = "https://user.invalid/erasure/purge";

export const connectionSuppressionStatus = 423;

export const confirmDrainUrl = "https://erasure.invalid/case/confirm-drain";

export const confirmPurgeUrl = "https://erasure.invalid/case/confirm-purge";

export const participantDrainedUrl = "https://owner.internal/erasure/drained";

export const confirmLifetimeCaseUrl = "https://erasure.invalid/case/lifetime";

export const participantCleanupUrl = "https://owner.internal/erasure/cleanup";

export const confirmCleanupUrl = "https://erasure.invalid/case/confirm-cleanup";

export const CleanupCommand = Schema.Struct({
  ...ErasureHandoff.fields,
  action: Schema.Literals(["clean", "release", "expire"]),
});

export const CleanupPermission = Schema.Struct({
  wompi: Schema.Boolean,
  whatsapp: Schema.Boolean,
});

export const CleanupProgress = Schema.Struct({
  done: Schema.Boolean,
  lastErasedAtMs: Schema.Int,
  protectUntilMs: Schema.Int,
});

export const erasureRecoveryWindowMs = 2_592_000_000;
