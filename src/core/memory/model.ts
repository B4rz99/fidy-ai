import { Schema, SchemaTransformation } from "effect";
import { UtcTimestamp } from "~/core/_shared/time";

const maximumMemoryTextLength = 2_000;

/** Stable server-generated identity for one current Memory. */
export const MemoryId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("MemoryId"))
  .annotate({ identifier: "MemoryId" });
export type MemoryId = typeof MemoryId.Type;

/** Formatting-normalized arbitrary prose retained for durable economic context. */
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

/** Public codec that canonicalizes line endings and outer whitespace without inspecting meaning. */
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

/** One current Memory belonging to the User in whose scope it is loaded. */
export const Memory = Schema.Struct({
  id: MemoryId,
  text: MemoryText,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
}).annotate({ identifier: "Memory" });
export type Memory = typeof Memory.Type;

const MemoryTextPayload = Schema.Struct({ text: MemoryTextInput });

/** Prose the caller explicitly asks Fidy to retain as a durable Memory. */
export const RememberInput = MemoryTextPayload.annotate({ identifier: "RememberInput" });
export type RememberInput = typeof RememberInput.Type;

/** Formatting-normalized replacement prose for one current Memory. */
export const ReviseInput = MemoryTextPayload.annotate({ identifier: "ReviseInput" });
export type ReviseInput = typeof ReviseInput.Type;

/** Every current Memory in stable ascending creation and identity order. */
export const RecallOutput = Schema.Array(Memory).annotate({ identifier: "RecallOutput" });
