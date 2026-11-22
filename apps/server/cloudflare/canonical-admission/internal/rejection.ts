import { Effect, Option, Schema } from "effect";
import { NextOperations } from "../../../src/shell/public-http/contract";
import {
  type CanonicalAdmissionFailure,
  CanonicalAdmissionUnavailable,
  type CanonicalRejection,
  type CanonicalRejectionDetail,
  type CanonicalWireOutcome,
  canonicalRejectionStatus,
  isCanonicalRejection,
} from "../contract";

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

export const catchRejection = <A, E, R>(
  self: Effect.Effect<A, E | CanonicalRejection, R>
): Effect.Effect<A | CanonicalWireOutcome, E, R> =>
  self.pipe(
    Effect.catchIf(
      (error): error is CanonicalRejection => isCanonicalRejection(error),
      (error) => Effect.succeed(encodeRejection(error))
    )
  );

export const rejectionResponse = (rejection: CanonicalRejection): Response => {
  const outcome = encodeRejection(rejection);

  return Response.json(outcome.body, {
    status: outcome.status,
    headers: { "cache-control": "no-store" },
  });
};
