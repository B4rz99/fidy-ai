import { Data } from "effect";
import type { Effect, Option } from "effect";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";
import { type ErasureClass } from "../../src/core/erasure/contract";

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
