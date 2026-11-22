import type { ErasureUnavailable } from "../erasure-store/contract";
import type { Effect } from "effect";
import { Schema } from "effect";
import { UserId } from "../../src/core/identity/contract";
import { ErasureCustodyEvidence, ErasureReference } from "../../src/core/erasure/contract";

const maximumOperatorLength = 256;

export const erasureRegistryName = "erasure-registry-v1";

export type ErasureRegistryNamespace = Readonly<{
  getByName: (
    name: string,
    options?: DurableObjectNamespaceGetDurableObjectOptions
  ) => Pick<Fetcher, "fetch">;
}> &
  Partial<Pick<DurableObjectNamespace, "idFromName">>;

const ErasureAuthority = Schema.Struct({
  permission: Schema.Literal("titular.erase"),
  operatorRef: Schema.String.check(Schema.isBetweenLength(1, maximumOperatorLength)),
  expiresAtMs: Schema.Int,
});

export const ErasureContinuation = Schema.Struct({
  userId: UserId,
  reference: ErasureReference,
  deadlineMs: Schema.Int,
  authority: ErasureAuthority,
});

export type ErasureContinuation = typeof ErasureContinuation.Type;

export type ErasureRegistry = Readonly<{
  get: (key: string) => ReturnType<R2Bucket["get"]>;
  head: R2Bucket["head"];
  put: (
    key: string,
    value: string,
    options?: Readonly<{ onlyIf: Pick<R2Conditional, "etagMatches" | "etagDoesNotMatch"> }>
  ) => ReturnType<R2Bucket["head"]>;
  delete: (key: string) => ReturnType<R2Bucket["delete"]>;
  list: (
    options: Pick<R2ListOptions, "limit" | "prefix" | "cursor">
  ) => ReturnType<R2Bucket["list"]>;
}>;

export const ErasureGeneration = Schema.Union([Schema.Literal("initial"), ErasureReference]);

export const ErasureCustodyAdmission = Schema.Struct({
  ...ErasureContinuation.fields,
  evidence: ErasureCustodyEvidence,
});

const custodyScopeFields = {
  custodian: Schema.Literals(["Resend", "Wompi", "Kapso", "Meta"]),
  after: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
};

export const CustodyScopeAdmission = Schema.Struct({
  ...ErasureContinuation.fields,
  ...custodyScopeFields,
});

export const scopeDirectoryUrl = "https://directory.invalid/erasure/custody-scope";

export const custodyScopePage = <Entry extends Readonly<{ cursor: unknown }>>(
  rows: ReadonlyArray<Entry>
): Response => {
  const pageSize = 16;

  return Response.json(
    {
      entries: rows.slice(0, pageSize).map(({ cursor: _cursor, ...projection }) => projection),
      next: rows.length > pageSize ? rows[pageSize - 1]?.cursor : null,
    },
    { headers: { "cache-control": "no-store" } }
  );
};

export const ErasureOperatorAction = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("CustodyScope"),
    userId: UserId,
    reference: ErasureReference,
    ...custodyScopeFields,
  }),
  Schema.Struct({
    action: Schema.Literal("CustodyEvidence"),
    userId: UserId,
    evidence: ErasureCustodyEvidence,
  }),
  Schema.Struct({
    action: Schema.Literal("Continue"),
    userId: UserId,
    reference: ErasureReference,
  }),
  Schema.Struct({ action: Schema.Literal("Receipt"), userId: UserId, reference: ErasureReference }),
]);

export type ErasureRegistryInitialization<Requirements = never> = Readonly<{
  query: (statement: string) => Effect.Effect<unknown, ErasureUnavailable, Requirements>;
  exists: (key: string) => Effect.Effect<boolean, ErasureUnavailable, Requirements>;
  empty: Effect.Effect<boolean, ErasureUnavailable, Requirements>;
  install: (key: string, value: string) => Effect.Effect<boolean, ErasureUnavailable, Requirements>;
}>;
