import { Schema } from "effect";
import type { toCodecOpenAI } from "effect/unstable/ai/OpenAiStructuredOutput";
import type { CanonicalOperationId } from "~/core/_shared/canonical-operation";
import type { CatalogOperation } from "~/shell/_shared/operation-catalog";

const maximumOpenAiToolNameLength = 64;

/** OpenAI-compatible alias mechanically derived from a canonical operation id. */
export const OpenAiToolName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
  Schema.isMaxLength(maximumOpenAiToolNameLength)
).pipe(Schema.brand("OpenAiToolName"));
export type OpenAiToolName = typeof OpenAiToolName.Type;

/**
 * Connects one provider-safe tool to its canonical operation declaration. `canonicalParameters`
 * governs API input, while `providerResponseParameters` accepts either strict OpenAI arguments or
 * the canonical encoded form returned by Effect's provider adapter. `wireJsonSchema` is the exact
 * strict schema published to OpenAI and must remain paired with that response codec.
 *
 * This declaration is a leaf so the canonical execution boundary and the confirmation boundary can
 * both name a binding without importing the toolkit that builds them.
 */
export type AgentOperationBinding = {
  readonly operation: CanonicalOperationId;
  readonly wireName: OpenAiToolName;
  readonly description: string;
  readonly canonicalParameters: CatalogOperation["input"];
  readonly providerResponseParameters: Schema.Codec<unknown, unknown, never, never>;
  readonly wireJsonSchema: ReturnType<typeof toCodecOpenAI>["jsonSchema"];
  readonly success: CatalogOperation["success"];
  readonly failure: CatalogOperation["failure"];
  readonly policy: CatalogOperation["policy"];
};

/** Encodes a canonical dot without changing any other operation identity text. */
export const encodeOpenAiToolName = (operation: CanonicalOperationId): OpenAiToolName =>
  OpenAiToolName.make(operation.replaceAll(".", "__"));
