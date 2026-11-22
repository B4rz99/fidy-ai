import { Effect } from "effect";
import {
  type CanonicalRejection,
  type CanonicalWireOutcome,
  encodeRejection,
  isCanonicalRejection,
} from "../contract";

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
