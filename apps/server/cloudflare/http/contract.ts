import { Data, Schema } from "effect";

/** Closed body-read failure safe to map to an HTTP reason without exposing stream details. */
export class BoundedBodyReadFailed extends Data.TaggedError("BoundedBodyReadFailed")<{
  readonly reason: "cancelled" | "malformed-file" | "resource-limit";
}> {}

/** The public request body exceeded the route's byte budget before it was accepted. */
export class RequestBodyCapacityExceeded extends Data.TaggedError("RequestBodyCapacityExceeded") {}

/** The public request body did not finish before the route's read deadline. */
export class RequestBodyDeadlineExceeded extends Data.TaggedError("RequestBodyDeadlineExceeded") {}

/** The public request body stream could not be acquired or read to completion. */
export class RequestBodyUnreadable extends Data.TaggedError("RequestBodyUnreadable") {}

const PositiveInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));

/**
 * Route-owned byte budget and deadline for accepting one public Worker request body. Decode route
 * constants through this schema so non-positive, non-finite, and fractional limits are impossible.
 */
export const RequestBodyPolicy = Schema.Struct({
  maximumBytes: PositiveInteger.pipe(Schema.brand("RequestBodyMaximumBytes")),
  deadlineMilliseconds: PositiveInteger.pipe(Schema.brand("RequestBodyDeadlineMilliseconds")),
});
export type RequestBodyPolicy = typeof RequestBodyPolicy.Type;
