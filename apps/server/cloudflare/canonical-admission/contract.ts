import type { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Context, Data, type Effect, Option, Predicate, type Schema } from "effect";
import { OperationAccessCaller } from "../../src/shell/canonical-policy/contract";
import type { AccessTier } from "../../src/core/access-tier/contract";
import { type FieldIssue } from "../../src/shell/public-http/contract";
import type { ErrorCode, SuggestedOperation } from "../../src/shell/public-http/contract";

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

export const canonicalRejectionStatus = {
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  conflict: 409,
  unprocessable: 422,
  tooManyRequests: 429,
} as const;

export type CanonicalRejectionStatus =
  (typeof canonicalRejectionStatus)[keyof typeof canonicalRejectionStatus];

export class CanonicalRejection extends Data.TaggedError("CanonicalRejection")<{
  readonly status: CanonicalRejectionStatus;
  readonly outcome: CanonicalOutcome;
  readonly code: ErrorCode;
  readonly message: Option.Option<string>;
  readonly fields: Option.Option<ReadonlyArray<typeof FieldIssue.Type>>;
  readonly detail: Option.Option<Readonly<Record<string, Schema.Json>>>;
  readonly next: ReadonlyArray<SuggestedOperation>;
  readonly batchChild: Option.Option<Readonly<{ index: number; operation: string }>>;
}> {}

export const isCanonicalRejection = (value: unknown): value is CanonicalRejection =>
  Predicate.isTagged("CanonicalRejection")(value);

export const rejection = (
  detail: Readonly<{
    status: CanonicalRejectionStatus;
    outcome: CanonicalOutcome;
    code: ErrorCode;
    message: Option.Option<string>;
    fields: Option.Option<ReadonlyArray<typeof FieldIssue.Type>>;
    extra: Option.Option<Readonly<Record<string, Schema.Json>>>;
    next: ReadonlyArray<SuggestedOperation>;
  }>
): CanonicalRejection =>
  new CanonicalRejection({
    status: detail.status,
    outcome: detail.outcome,
    code: detail.code,
    message: detail.message,
    fields: detail.fields,
    detail: detail.extra,
    next: detail.next,
    batchChild: Option.none(),
  });

export const validationRejection = (message: string): CanonicalRejection =>
  rejection({
    status: canonicalRejectionStatus.badRequest,
    outcome: "validation_failed",
    code: "validation_failed",
    message: Option.some(message),
    fields: Option.some([]),
    extra: Option.none(),
    next: [],
  });

export const unfieldedValidationRejection = (message: string): CanonicalRejection =>
  rejection({
    status: canonicalRejectionStatus.badRequest,
    outcome: "validation_failed",
    code: "validation_failed",
    message: Option.some(message),
    fields: Option.none(),
    extra: Option.none(),
    next: [],
  });

export const notFoundRejection = (message: string): CanonicalRejection =>
  rejection({
    status: canonicalRejectionStatus.notFound,
    outcome: "not_found",
    code: "not_found",
    message: Option.some(message),
    fields: Option.none(),
    extra: Option.none(),
    next: [],
  });

export const resourceLimitRejection = (message: string): CanonicalRejection =>
  rejection({
    status: canonicalRejectionStatus.conflict,
    outcome: "resource_limit",
    code: "quota_exhausted",
    message: Option.some(message),
    fields: Option.none(),
    extra: Option.none(),
    next: [],
  });

export const unauthenticatedRejection = (message: string): CanonicalRejection =>
  rejection({
    status: canonicalRejectionStatus.unauthorized,
    outcome: "validation_failed",
    code: "unauthenticated",
    message: Option.some(message),
    fields: Option.none(),
    extra: Option.none(),
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

export type LocalMutationResult = Readonly<{
  status: number;
  outcome: "success";
  body: Schema.Json;
}>;

export type LocalMutationOutcome = Readonly<{
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
  commit: Effect.Effect<LocalMutationResult, CanonicalAdmissionFailure, SqliteClient>;
}>;

export type LocalMutationPreparation = LocalMutationResult | LocalMutationPlan;
