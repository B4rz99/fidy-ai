import {
  CanonicalCapability,
  CanonicalOperationId,
} from "../../src/core/canonical-operations/contract";
import { maximumAtomicBatchCalls } from "../../src/shell/operations/contract";
import { Predicate, Schema } from "effect";

export const BatchCalls = Schema.NonEmptyArray(Schema.Unknown).check(
  Schema.isMaxLength(maximumAtomicBatchCalls)
);

export type BatchCalls = typeof BatchCalls.Type;

const Batch = { calls: BatchCalls } as const;

const Call = {
  operation: CanonicalOperationId,
  input: Schema.Unknown,
} as const;

export const CanonicalWork = Schema.Union([
  Schema.TaggedStruct("Call", Call),
  Schema.TaggedStruct("Query", {
    operation: CanonicalOperationId,
    target: Schema.String.check(Schema.isPattern(/^\//u)),
  }),
  Schema.TaggedStruct("Batch", Batch),
]);

export type CanonicalWork = typeof CanonicalWork.Type;

export const BatchInput = Schema.Struct(Batch);

export type BatchInput = typeof BatchInput.Type;

const Credentials = {
  userId: Schema.String.check(Schema.isUUID()),
  digest: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
} as const;

const WebSession = { ...Credentials, sessionId: Schema.String.check(Schema.isUUID()) } as const;

const PAT = {
  ...Credentials,
  patId: Schema.String.check(Schema.isUUID()),
  requiredScope: Schema.NullOr(CanonicalCapability),
} as const;

const WebSessionWork = Schema.TaggedStruct("WebSessionWork", {
  ...WebSession,
  work: CanonicalWork,
});

const PATWork = Schema.TaggedStruct("PATWork", { ...PAT, work: CanonicalWork });

export const CanonicalWorkAdmission = Schema.Union([
  Schema.TaggedStruct("WebSessionQueryWork", {
    ...WebSession,
    work: CanonicalWork.check(
      Schema.makeFilter(
        (work) =>
          Predicate.isTagged(work, "Query") &&
          ["dashboard.getDashboardView", "recurringPlans.getRecurringWorkspace"].includes(
            work.operation
          )
      )
    ),
    leaseId: Schema.String.check(Schema.isUUID()),
  }),
  WebSessionWork,
  PATWork,
]);

export type CanonicalWorkAdmission = typeof CanonicalWorkAdmission.Type;

type WebSessionAuthority = Omit<typeof WebSessionWork.Type, "_tag" | "work">;

type PATAuthority = Omit<typeof PATWork.Type, "_tag" | "work">;

export type { PATAuthority, WebSessionAuthority };
