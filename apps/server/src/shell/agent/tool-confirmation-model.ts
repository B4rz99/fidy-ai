import type { Effect, Schema as SchemaNamespace } from "effect";
import { Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { AgentOperationBinding } from "./agent-operation-binding";

/** Cryptographically unique lowercase hexadecimal identity of one exact confirmation challenge. */
export const ConfirmationDigest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(
  Schema.brand("ConfirmationDigest")
);
/** Cryptographically unique lowercase hexadecimal identity of one exact confirmation challenge. */
export type ConfirmationDigest = typeof ConfirmationDigest.Type;

/**
 * Single-use authority to execute exactly one confirmed canonical call. It lives beside the digest
 * so the canonical execution boundary can require a permit without importing the confirmation
 * workflow that issues one.
 */
export type ConfirmationPermit = Readonly<{
  consume: (input: {
    readonly binding: Readonly<AgentOperationBinding>;
    readonly canonicalInput: SchemaNamespace.Json;
  }) => Effect.Effect<boolean, never, SqlClient.SqlClient>;
}>;
