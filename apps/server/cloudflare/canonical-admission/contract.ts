import type { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Context, Data, type Effect, Option, Schema } from "effect";
import { OperationAccessCaller } from "../../src/shell/canonical-policy/contract";
import type { AccessTier } from "../../src/core/access-tier/contract";
import { ErrorCode, FieldIssue, NextOperations } from "../../src/shell/public-http/contract";
import type { SuggestedOperation } from "../../src/shell/public-http/contract";

export const CurrentSuggestionCaller = Context.Reference<
  Readonly<{ accessCaller: OperationAccessCaller; tier: AccessTier }>
>("@fidy/cloudflare/CurrentSuggestionCaller", {
  defaultValue: () => ({
    accessCaller: OperationAccessCaller.PAT({ capabilities: [] }),
    tier: "free",
  }),
});

export class CanonicalAdmissionUnavailable extends Data.TaggedError(
  "CanonicalAdmissionUnavailable"
)<{ readonly cause: unknown }> {}

export type CanonicalOutcome = "success" | "validation_failed" | "not_found" | "resource_limit";

export type CanonicalRejectionOutcome = Exclude<CanonicalOutcome, "success">;

export type CanonicalRejectionAudit =
  | Readonly<{ kind: "rejected"; outcome: CanonicalRejectionOutcome }>
  | Readonly<{ kind: "accepted"; outcome: "success" }>;

export type CanonicalRejectionDetail =
  | Readonly<{ kind: "rate_limited"; retryAfterSeconds: number }>
  | Readonly<{ kind: "reauthentication"; userId: string }>;

export const canonicalRejectionStatus = {
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  conflict: 409,
  unprocessable: 422,
  tooManyRequests: 429,
} as const;

export const canonicalRejectionStatuses = Object.values(canonicalRejectionStatus);

export type CanonicalRejectionStatus =
  (typeof canonicalRejectionStatus)[keyof typeof canonicalRejectionStatus];

export class CanonicalRejection extends Data.TaggedError("CanonicalRejection")<{
  readonly status: CanonicalRejectionStatus;
  readonly audit: CanonicalRejectionAudit;
  readonly code: ErrorCode;
  readonly wireMessage: Option.Option<string>;
  readonly fields: Option.Option<ReadonlyArray<typeof FieldIssue.Type>>;
  readonly detail: Option.Option<CanonicalRejectionDetail>;
  readonly next: ReadonlyArray<SuggestedOperation>;
  readonly batchChild: Option.Option<Readonly<{ index: number; operation: string }>>;
}> {}

const rejectionAuditGuard = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("rejected"),
    outcome: Schema.Literals(["validation_failed", "not_found", "resource_limit"]),
  }),
  Schema.Struct({ kind: Schema.Literal("accepted"), outcome: Schema.Literal("success") }),
]);

const rejectionDetailGuard = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("rate_limited"), retryAfterSeconds: Schema.Finite }),
  Schema.Struct({ kind: Schema.Literal("reauthentication"), userId: Schema.String }),
]);

const rejectionGuard = Schema.TaggedStruct("CanonicalRejection", {
  status: Schema.Literals(canonicalRejectionStatuses),
  audit: rejectionAuditGuard,
  code: ErrorCode,
  wireMessage: Schema.Option(Schema.String),
  fields: Schema.Option(Schema.Array(FieldIssue)),
  detail: Schema.Option(rejectionDetailGuard),
  next: NextOperations,
  batchChild: Schema.Option(Schema.Struct({ index: Schema.Int, operation: Schema.String })),
});

export const isCanonicalRejection = (value: unknown): value is CanonicalRejection =>
  Schema.is(rejectionGuard)(value);

export const admissionFailure = (cause: unknown): CanonicalAdmissionFailure =>
  isCanonicalRejection(cause) ? cause : new CanonicalAdmissionUnavailable({ cause });

const encodeNext = Schema.encodeSync(Schema.toCodecJson(NextOperations));

type RejectionDetailFields =
  | Readonly<Record<never, never>>
  | Readonly<{ retryAfterSeconds: number }>
  | Readonly<{ reason: "reauthentication_required"; userId: string }>;

const detailFields = (detail: Option.Option<CanonicalRejectionDetail>): RejectionDetailFields =>
  Option.match(detail, {
    onNone: () => ({}),
    onSome: (value) => {
      switch (value.kind) {
        case "rate_limited":
          return { retryAfterSeconds: value.retryAfterSeconds };
        case "reauthentication":
          return { reason: "reauthentication_required" as const, userId: value.userId };
        default: {
          const exhaustive: never = value;

          return exhaustive;
        }
      }
    },
  });

const errorDetail = (
  rejection: CanonicalRejection,
  detail: RejectionDetailFields
): Schema.Json => ({
  code: rejection.code,
  ...Option.match(rejection.wireMessage, {
    onNone: () => ({}),
    onSome: (message) => ({ message }),
  }),
  ...Option.match(rejection.fields, {
    onNone: () => ({}),
    onSome: (fields) => ({ fields }),
  }),
  ...detail,
});

const childError = (
  rejection: CanonicalRejection,
  child: Readonly<{ index: number; operation: string }>
): Schema.Json => ({
  code: rejection.code,
  message: Option.getOrElse(rejection.wireMessage, () => ""),
  failedCallIndex: child.index,
  operation: child.operation,
  fields: Option.getOrElse(rejection.fields, () => []),
});

export const encodeRejection = (rejection: CanonicalRejection): CanonicalWireOutcome => {
  const child = Option.getOrUndefined(rejection.batchChild);

  if (child !== undefined) {
    return {
      status: canonicalRejectionStatus.badRequest,
      outcome: "validation_failed",
      body: { error: childError(rejection, child), next: [] },
    };
  }

  return {
    status: rejection.status,
    outcome: rejection.audit.outcome,
    body: {
      error: errorDetail(rejection, detailFields(rejection.detail)),
      next: encodeNext(rejection.next),
    },
  };
};

export const rejection = (
  detail: Readonly<{
    status: CanonicalRejectionStatus;
    outcome: CanonicalRejectionOutcome;
    code: ErrorCode;
    wireMessage: Option.Option<string>;
    fields: Option.Option<ReadonlyArray<typeof FieldIssue.Type>>;
    detail: Option.Option<CanonicalRejectionDetail>;
    next: ReadonlyArray<SuggestedOperation>;
  }>
): CanonicalRejection =>
  new CanonicalRejection({
    status: detail.status,
    audit: { kind: "rejected", outcome: detail.outcome },
    code: detail.code,
    wireMessage: detail.wireMessage,
    fields: detail.fields,
    detail: detail.detail,
    next: Schema.decodeSync(NextOperations)(detail.next),
    batchChild: Option.none(),
  });

export const acceptedReadRejection = (
  detail: Readonly<{
    status: CanonicalRejectionStatus;
    code: ErrorCode;
    wireMessage: Option.Option<string>;
    fields: Option.Option<ReadonlyArray<typeof FieldIssue.Type>>;
    detail: Option.Option<CanonicalRejectionDetail>;
    next: ReadonlyArray<SuggestedOperation>;
  }>
): CanonicalRejection =>
  new CanonicalRejection({
    status: detail.status,
    audit: { kind: "accepted", outcome: "success" },
    code: detail.code,
    wireMessage: detail.wireMessage,
    fields: detail.fields,
    detail: detail.detail,
    next: Schema.decodeSync(NextOperations)(detail.next),
    batchChild: Option.none(),
  });

export const validationRejection = (message: string): CanonicalRejection =>
  rejection({
    status: canonicalRejectionStatus.badRequest,
    outcome: "validation_failed",
    code: "validation_failed",
    wireMessage: Option.some(message),
    fields: Option.some([]),
    detail: Option.none(),
    next: [],
  });

export const bareValidationRejection = (message: string): CanonicalRejection =>
  rejection({
    status: canonicalRejectionStatus.badRequest,
    outcome: "validation_failed",
    code: "validation_failed",
    wireMessage: Option.some(message),
    fields: Option.none(),
    detail: Option.none(),
    next: [],
  });

export const notFoundRejection = (message: string): CanonicalRejection =>
  rejection({
    status: canonicalRejectionStatus.notFound,
    outcome: "not_found",
    code: "not_found",
    wireMessage: Option.some(message),
    fields: Option.none(),
    detail: Option.none(),
    next: [],
  });

export const resourceLimitRejection = (message: string): CanonicalRejection =>
  rejection({
    status: canonicalRejectionStatus.conflict,
    outcome: "resource_limit",
    code: "quota_exhausted",
    wireMessage: Option.some(message),
    fields: Option.none(),
    detail: Option.none(),
    next: [],
  });

export const unauthenticatedRejection = (message: string): CanonicalRejection =>
  rejection({
    status: canonicalRejectionStatus.unauthorized,
    outcome: "validation_failed",
    code: "unauthenticated",
    wireMessage: Option.some(message),
    fields: Option.none(),
    detail: Option.none(),
    next: [],
  });

export type CanonicalAdmissionFailure = CanonicalAdmissionUnavailable | CanonicalRejection;

export const canonicalRequestProtection = {
  intervalMs: 100,
  burst: 10,
  concurrency: 2,
  leaseMs: 90000,
  retryAfterSeconds: 1,
} as const;

export const canonicalSuccessStatus = {
  ok: 200,
  created: 201,
} as const;

export type CanonicalSuccessStatus =
  (typeof canonicalSuccessStatus)[keyof typeof canonicalSuccessStatus];

export type LocalMutationResult = Readonly<{
  status: CanonicalSuccessStatus;
  outcome: "success";
  body: Schema.Json;
}>;

export type CanonicalWireOutcome = Readonly<{
  status: number;
  outcome: CanonicalOutcome;
  body: Schema.Json;
}>;

export type LocalReviewFacts = { effect: string; revision: string };

export type LocalMutationPlan = Readonly<{
  review: Option.Option<Effect.Effect<LocalReviewFacts, CanonicalAdmissionFailure, SqliteClient>>;
  premises: ReadonlyArray<string>;
  targets: ReadonlyArray<string>;
  removedTarget: Option.Option<string>;
  writes: boolean;
  commit: Effect.Effect<LocalMutationResult, CanonicalAdmissionFailure, SqliteClient>;
}>;
