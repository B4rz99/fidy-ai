import { Effect, Option, Schema } from "effect";
import { NextOperations } from "../../../src/shell/public-http/contract";
import {
  type CanonicalAdmissionFailure,
  CanonicalAdmissionUnavailable,
  type CanonicalRejection,
  type LocalMutationOutcome,
  canonicalRejectionStatus,
  isCanonicalRejection,
} from "../contract";

const encodeNext = Schema.encodeSync(Schema.toCodecJson(NextOperations));

export const admissionFailure = (cause: unknown): CanonicalAdmissionFailure =>
  isCanonicalRejection(cause) ? cause : new CanonicalAdmissionUnavailable({ cause });

export const catchRejection = <A, E, R>(
  self: Effect.Effect<A, E | CanonicalRejection, R>
): Effect.Effect<A | LocalMutationOutcome, E, R> =>
  self.pipe(
    Effect.catchIf(
      (error): error is CanonicalRejection => isCanonicalRejection(error),
      (error) => Effect.succeed(encodeRejection(error))
    )
  );

const errorDetail = (rejection: CanonicalRejection): Schema.Json => ({
  code: rejection.code,
  ...Option.match(rejection.message, {
    onNone: () => ({}),
    onSome: (message) => ({ message }),
  }),
  ...Option.match(rejection.fields, {
    onNone: () => ({}),
    onSome: (fields) => ({ fields }),
  }),
  ...Option.getOrElse(rejection.detail, () => ({})),
});

const childError = (
  rejection: CanonicalRejection,
  child: Readonly<{ index: number; operation: string }>
): Schema.Json => ({
  code: rejection.code,
  message: Option.getOrElse(rejection.message, () => ""),
  failedCallIndex: child.index,
  operation: child.operation,
  fields: Option.getOrElse(rejection.fields, () => []),
});

export const encodeRejection = (rejection: CanonicalRejection): LocalMutationOutcome => {
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
    outcome: rejection.outcome,
    body: {
      error: errorDetail(rejection),
      next: encodeNext(rejection.next),
    },
  };
};

export const rejectionResponse = (rejection: CanonicalRejection): Response => {
  const outcome = encodeRejection(rejection);

  return Response.json(outcome.body, {
    status: outcome.status,
    headers: { "cache-control": "no-store" },
  });
};
