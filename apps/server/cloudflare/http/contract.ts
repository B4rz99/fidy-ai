import { Data, Schema } from "effect";

export class BoundedBodyReadFailed extends Data.TaggedError("BoundedBodyReadFailed")<{
  readonly reason: "cancelled" | "malformed-file" | "resource-limit";
}> {}

export class RequestBodyCapacityExceeded extends Data.TaggedError("RequestBodyCapacityExceeded") {}

export class RequestBodyDeadlineExceeded extends Data.TaggedError("RequestBodyDeadlineExceeded") {}

export class RequestBodyUnreadable extends Data.TaggedError("RequestBodyUnreadable") {}

const PositiveInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));

export const RequestBodyPolicy = Schema.Struct({
  maximumBytes: PositiveInteger.pipe(Schema.brand("RequestBodyMaximumBytes")),
  deadlineMilliseconds: PositiveInteger.pipe(Schema.brand("RequestBodyDeadlineMilliseconds")),
});

export type RequestBodyPolicy = typeof RequestBodyPolicy.Type;
