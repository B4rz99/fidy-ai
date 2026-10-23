import { Data, Schema } from "effect";
import type { Effect, Option } from "effect";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";
import { type ErasureClass } from "../../src/core/erasure/contract";

export class ErasureUnavailable extends Data.TaggedError("ErasureUnavailable") {}
export type ErasureScope = Readonly<{ userId: string; reference: string }>;
export type ErasureOriginals = Readonly<{
  checkpoint: (scope: ErasureScope) => Effect.Effect<boolean, ErasureUnavailable>;
  purge: (scope: ErasureScope) => Effect.Effect<boolean, ErasureUnavailable>;
  archive: (scope: ErasureScope) => Effect.Effect<boolean, ErasureUnavailable>;
  capture: (scope: ErasureScope) => Effect.Effect<boolean, ErasureUnavailable>;
  discard: (
    scope: ErasureScope
  ) => Effect.Effect<"Done" | "Continue" | "Retained", ErasureUnavailable>;
}>;
/** The key projection exposes only bucket and object_key for the supplied User. Buckets are private native bindings; absent bindings refuse any affected object. */
export type ErasureOriginalConfiguration = Readonly<{
  db: D1Database;
  email: Option.Option<R2Bucket>;
  statement: Option.Option<R2Bucket>;
  retained: Option.Option<R2Bucket>;
  keys: (userId: string) => OwnedStatement;
}>;
export type ErasureStore = Readonly<{
  id: string;
  dataClass: ErasureClass;
  dependencies: ReadonlyArray<string>;
  archive: (scope: ErasureScope) => Effect.Effect<boolean, ErasureUnavailable>;
  remove: (scope: ErasureScope) => Effect.Effect<boolean, ErasureUnavailable>;
  protectDrained: (
    input: Readonly<{ statement: OwnedStatement; scope: ErasureScope; current: number }>
  ) => OwnedStatement;
}>;
/** Caller-owned projections select opaque rowRef and purpose-qualified JSON body; values remain bound, never executable SQL. */
export type ErasureProjection = Readonly<{
  id: string;
  dataClass: ErasureClass;
  dependencies: ReadonlyArray<string>;
  select: (userId: string) => OwnedStatement;
  candidates: (userId: string) => OwnedStatement;
  quiescence:
    | Readonly<{ _tag: "Synchronous" }>
    | Readonly<{
        _tag: "Durable";
        select: (input: Readonly<{ userId: string; current: number }>) => OwnedStatement;
      }>;
  remove: (scope: ErasureScope) => ReadonlyArray<OwnedStatement>;
  remaining: (userId: string) => OwnedStatement;
}>;

export const ErasureOriginalLocator = Schema.Union([
  Schema.Struct({
    bucket: Schema.Literal("email"),
    key: Schema.String.check(
      Schema.isPattern(
        /^(?:users\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/)?email\/v1\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      )
    ),
  }),
  Schema.Struct({
    bucket: Schema.Literal("statement"),
    key: Schema.String.check(
      Schema.isPattern(
        /^(?:users\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/)?staging\/statement\/v1\/[0-9a-f]{64}$/u
      )
    ),
  }),
]);
