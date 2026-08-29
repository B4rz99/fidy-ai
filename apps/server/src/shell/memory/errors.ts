import { SchemaSerializableError } from "~/schema-compatibility";
import { Schema } from "effect";
import type { MemoryCapacityExceeded, MemoryNotFound } from "~/core/memory/rules";
import { NotFound } from "~/shell/_shared/errors";
import { NextOperations } from "~/shell/_shared/response";

/** Declared content-free failure when a Memory write would exceed aggregate capacity. */
export class MemoryCapacityExceededApi extends SchemaSerializableError<MemoryCapacityExceededApi>(
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

/** Maps the closed Memory failure set without copying prose or caller-controlled identity. */
export function mapMemoryFailure(failure: MemoryCapacityExceeded): MemoryCapacityExceededApi;
export function mapMemoryFailure(failure: MemoryNotFound): NotFound;
export function mapMemoryFailure(
  failure: MemoryCapacityExceeded | MemoryNotFound
): MemoryCapacityExceededApi | NotFound {
  switch (failure._tag) {
    case "MemoryCapacityExceeded":
      return MemoryCapacityExceededApi.make({
        error: {
          code: "quota_exhausted",
          message: "Saving this text would exceed the User's current Memory capacity.",
        },
        next: [],
      });
    case "MemoryNotFound":
      return NotFound.make({
        error: {
          code: "not_found",
          message: "No current Memory with that identifier belongs to you.",
        },
        next: [],
      });
  }
}
