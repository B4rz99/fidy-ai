import { Data, Schema, SchemaTransformation } from "effect";
import { UtcTimestamp } from "~/core/_shared/time";

const maximumMemoryTextLength = 2_000;

export const MemoryId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("MemoryId"))
  .annotate({ identifier: "MemoryId" });

export type MemoryId = typeof MemoryId.Type;

export const MemoryText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(maximumMemoryTextLength),
  Schema.isTrimmed()
)
  .pipe(Schema.brand("MemoryText"))
  .annotate({ identifier: "MemoryText" });

export type MemoryText = typeof MemoryText.Type;

const normalizeMemoryFormatting = (text: string): string =>
  text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();

export const MemoryTextInput = Schema.String.pipe(
  Schema.decodeTo(
    MemoryText,
    SchemaTransformation.transform({
      decode: normalizeMemoryFormatting,
      encode: (text) => text,
    })
  )
);

export type MemoryTextInput = typeof MemoryTextInput.Type;

export const Memory = Schema.Struct({
  id: MemoryId,
  text: MemoryText,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
}).annotate({ identifier: "Memory" });

export type Memory = typeof Memory.Type;

const MemoryTextPayload = Schema.Struct({ text: MemoryTextInput });

export const RememberInput = MemoryTextPayload.annotate({ identifier: "RememberInput" });

export type RememberInput = typeof RememberInput.Type;

export const ReviseInput = MemoryTextPayload.annotate({ identifier: "ReviseInput" });

export type ReviseInput = typeof ReviseInput.Type;

export const RecallOutput = Schema.Array(Memory).annotate({ identifier: "RecallOutput" });

export class MemoryCapacityExceeded extends Data.TaggedError("MemoryCapacityExceeded")<{}> {
  override get message(): string {
    return "The User's current Memories have reached their aggregate token capacity";
  }
}

export class MemoryNotFound extends Data.TaggedError("MemoryNotFound")<{}> {
  override get message(): string {
    return "No current Memory belongs to the User";
  }
}

export const maximumAggregateMemoryTokens = 15_000;
