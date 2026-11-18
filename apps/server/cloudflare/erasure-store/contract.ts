import { UserId } from "../../src/core/identity/contract";
import { type ErasureClass, ErasureReference } from "../../src/core/erasure/contract";
import { Data, Schema } from "effect";
import type { Effect, Option } from "effect";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";

export class ErasureUnavailable extends Data.TaggedError("ErasureUnavailable") {}
export type ErasureScope = Readonly<{ userId: string; reference: string }>;
export type ErasureOriginals = Readonly<{
  discard: (scope: ErasureScope) => Effect.Effect<"Done" | "Continue", ErasureUnavailable>;
}>;
/** Every configured private bucket is swept under the canonical User prefix; absent bindings refuse completion. */
export type ErasureOriginalConfiguration = Readonly<{
  db: D1Database;
  email: Option.Option<R2Bucket>;
  statement: Option.Option<R2Bucket>;
  registry: Option.Option<R2Bucket>;
}>;
export type ErasureStore = Readonly<{
  id: string;
  dataClass: ErasureClass;
  dependencies: ReadonlyArray<string>;
  remove: (scope: ErasureScope) => Effect.Effect<boolean, ErasureUnavailable>;
  protectDrained: (
    input: Readonly<{ statement: OwnedStatement; scope: ErasureScope; current: number }>
  ) => OwnedStatement;
}>;
/** Caller-owned deletion projections expose opaque row references; values remain bound, never executable SQL. */
export type ErasureProjection = Readonly<{
  id: string;
  dataClass: ErasureClass;
  dependencies: ReadonlyArray<string>;
  candidates: (userId: string) => OwnedStatement;
  quiescence:
    | Readonly<{ _tag: "Synchronous" }>
    | Readonly<{
        _tag: "Durable";
        select: (input: Readonly<{ userId: string; current: number }>) => OwnedStatement;
      }>;
  remove: (
    selection: ErasureScope & Readonly<{ rowRefsJson: string }>
  ) => ReadonlyArray<OwnedStatement>;
  remaining: (userId: string) => OwnedStatement;
}>;

/** The named owners exchange only the exact erasure identity and its original admission time. */
export const ErasureHandoff = Schema.Struct({
  userId: UserId,
  reference: ErasureReference,
  requestedAtMs: Schema.Int.check(Schema.isGreaterThan(0)),
});
export const registerCaseUrl = "https://erasure.invalid/case/register";
export const confirmHandoffUrl = "https://user.invalid/erasure/confirm";
export const participantFenceUrl = "https://owner.internal/erasure/fence";

export const confirmLifetimeCaseUrl = "https://erasure.invalid/case/lifetime";
