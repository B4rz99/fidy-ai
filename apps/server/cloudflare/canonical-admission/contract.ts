import type { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Context, Data, type Effect, Option, Schema } from "effect";
import { OperationAccessCaller } from "../../src/shell/canonical-policy/contract";
import type { AccessTier } from "../../src/core/access-tier/contract";
import {
  ErrorCode,
  FieldIssue,
  type SuggestedOperation,
  SuggestedOperation as SuggestedOperationSchema,
} from "../../src/shell/public-http/contract";

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
  Schema.Struct({
    kind: Schema.Literal("rate_limited"),
    retryAfterSeconds: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  Schema.Struct({ kind: Schema.Literal("reauthentication"), userId: Schema.String }),
]);

const nextGuard = Schema.Array(SuggestedOperationSchema).check(Schema.isMaxLength(3));

const rejectionGuard = Schema.TaggedStruct("CanonicalRejection", {
  status: Schema.Literals(canonicalRejectionStatuses),
  audit: rejectionAuditGuard,
  code: ErrorCode,
  wireMessage: Schema.Option(Schema.String),
  fields: Schema.Option(Schema.Array(FieldIssue)),
  detail: Schema.Option(rejectionDetailGuard),
  next: nextGuard,
  batchChild: Schema.Option(Schema.Struct({ index: Schema.Int, operation: Schema.String })),
});

export const isCanonicalRejection = (value: unknown): value is CanonicalRejection =>
  Schema.is(rejectionGuard)(value);

const coherentRejections = [
  {
    status: canonicalRejectionStatus.badRequest,
    code: "validation_failed",
    outcome: "validation_failed",
  },
  {
    status: canonicalRejectionStatus.unauthorized,
    code: "unauthenticated",
    outcome: "validation_failed",
  },
  {
    status: canonicalRejectionStatus.forbidden,
    code: "user_action_required",
    outcome: "validation_failed",
  },
  { status: canonicalRejectionStatus.notFound, code: "not_found", outcome: "not_found" },
  {
    status: canonicalRejectionStatus.notFound,
    code: "dashboard_uninitialized",
    outcome: "success",
  },
  {
    status: canonicalRejectionStatus.conflict,
    code: "user_action_required",
    outcome: "validation_failed",
  },
  {
    status: canonicalRejectionStatus.conflict,
    code: "quota_exhausted",
    outcome: "resource_limit",
  },
  {
    status: canonicalRejectionStatus.unprocessable,
    code: "user_action_required",
    outcome: "validation_failed",
  },
  {
    status: canonicalRejectionStatus.tooManyRequests,
    code: "rate_limited",
    outcome: "validation_failed",
  },
] as const;

const rejectionIsCoherent = (
  status: CanonicalRejectionStatus,
  code: ErrorCode,
  outcome: CanonicalOutcome
): boolean =>
  coherentRejections.some(
    (entry) => entry.status === status && entry.code === code && entry.outcome === outcome
  );

const assertRejection = (
  status: CanonicalRejectionStatus,
  code: ErrorCode,
  outcome: CanonicalOutcome
): void => {
  if (!rejectionIsCoherent(status, code, outcome)) {
    throw new Error("Incoherent canonical rejection");
  }
};

const assertDetail = (
  detail: Option.Option<CanonicalRejectionDetail>
): Option.Option<CanonicalRejectionDetail> =>
  Option.map(detail, (value) => Schema.decodeSync(rejectionDetailGuard)(value));

const assertNext = (next: ReadonlyArray<SuggestedOperation>): void => {
  if (!Schema.is(nextGuard)(next)) {
    throw new Error("Invalid canonical rejection suggestions");
  }
};

const childRejectionIsCoherent = (code: ErrorCode, outcome: CanonicalRejectionOutcome): boolean =>
  (code === "not_found" && outcome === "not_found") ||
  (code === "quota_exhausted" && outcome === "resource_limit") ||
  (outcome === "validation_failed" && code !== "not_found" && code !== "quota_exhausted");

const assertChildRejection = (code: ErrorCode, outcome: CanonicalRejectionOutcome): void => {
  if (!childRejectionIsCoherent(code, outcome)) {
    throw new Error("Incoherent canonical child rejection");
  }
};

export const childRejectionMessage = "The requested record is unavailable.";

export const childRejection = (
  failure: Readonly<{
    index: number;
    operation: string;
    code: ErrorCode;
    message: string;
    outcome: CanonicalRejectionOutcome;
  }>
): CanonicalRejection => {
  assertChildRejection(failure.code, failure.outcome);

  return new CanonicalRejection({
    status: canonicalRejectionStatus.badRequest,
    audit: { kind: "rejected", outcome: failure.outcome },
    code: failure.code,
    wireMessage: Option.some(
      failure.message.length === 0 ? childRejectionMessage : failure.message
    ),
    fields: Option.some([]),
    detail: Option.none(),
    next: [],
    batchChild: Option.some({ index: failure.index, operation: failure.operation }),
  });
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
): CanonicalRejection => {
  assertRejection(detail.status, detail.code, detail.outcome);
  assertNext(detail.next);

  return new CanonicalRejection({
    status: detail.status,
    audit: { kind: "rejected", outcome: detail.outcome },
    code: detail.code,
    wireMessage: detail.wireMessage,
    fields: detail.fields,
    detail: assertDetail(detail.detail),
    next: detail.next,
    batchChild: Option.none(),
  });
};

export const acceptedReadRejection = (
  detail: Readonly<{
    status: CanonicalRejectionStatus;
    code: ErrorCode;
    wireMessage: Option.Option<string>;
    fields: Option.Option<ReadonlyArray<typeof FieldIssue.Type>>;
    detail: Option.Option<CanonicalRejectionDetail>;
    next: ReadonlyArray<SuggestedOperation>;
  }>
): CanonicalRejection => {
  assertRejection(detail.status, detail.code, "success");
  assertNext(detail.next);

  return new CanonicalRejection({
    status: detail.status,
    audit: { kind: "accepted", outcome: "success" },
    code: detail.code,
    wireMessage: detail.wireMessage,
    fields: detail.fields,
    detail: assertDetail(detail.detail),
    next: detail.next,
    batchChild: Option.none(),
  });
};

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

export const committedResult = (data: Schema.Json): LocalMutationResult => ({
  status: 200,
  outcome: "success",
  body: { data, next: [] },
});

export type CanonicalWireOutcome = Readonly<{
  status: number;
  outcome: CanonicalOutcome;
  body: Schema.Json;
}>;

export type LocalReviewFacts = { effect: string; revision: string };

export type LocalMutationTransaction = "none" | "caller" | "self";

export type LocalMutationPlan = Readonly<{
  review: Option.Option<Effect.Effect<LocalReviewFacts, CanonicalAdmissionFailure, SqliteClient>>;
  premises: ReadonlyArray<string>;
  targets: ReadonlyArray<string>;
  removedTarget: Option.Option<string>;
  transaction: LocalMutationTransaction;
  commit: Effect.Effect<LocalMutationResult, CanonicalAdmissionFailure, SqliteClient>;
}>;
