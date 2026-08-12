import { Schema } from "effect";
import type { MemoryCapacityExceeded } from "~/core/memory/rules";
import { NextOperations } from "~/shell/_shared/response";

/** Declared content-free failure when a remember call would exceed aggregate Memory capacity. */
export class MemoryCapacityExceededApi extends Schema.ErrorClass<MemoryCapacityExceededApi>(
  "MemoryCapacityExceededApi"
)(
  {
    _tag: Schema.tagDefaultOmit("MemoryCapacityExceededApi"),
    error: Schema.Struct({
      code: Schema.Literal("quota_exhausted"),
      message: Schema.NonEmptyString,
    }),
    next: NextOperations,
  },
  { httpApiStatus: 409 }
) {
  override get message(): string {
    return this.error.message;
  }
}

/** Maps the closed Memory policy failure without copying its candidate or aggregate. */
export const mapMemoryFailure = (_failure: MemoryCapacityExceeded): MemoryCapacityExceededApi =>
  MemoryCapacityExceededApi.make({
    error: {
      code: "quota_exhausted",
      message: "Remembering this text would exceed the User's current Memory capacity.",
    },
    next: [],
  });
