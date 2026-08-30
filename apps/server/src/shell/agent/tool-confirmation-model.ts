import type { Effect, Schema as SchemaNamespace } from "effect";
import { Option, Schema } from "effect";
import type { ProviderQualifiedMessages } from "~/core/consent/model";
import type { SqlClient } from "effect/unstable/sql";
import type { AgentOperationBinding } from "./agent-operation-binding";

/** Cryptographically unique lowercase hexadecimal identity of one exact confirmation challenge. */
export const ConfirmationDigest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(
  Schema.brand("ConfirmationDigest")
);
/** Cryptographically unique lowercase hexadecimal identity of one exact confirmation challenge. */
export type ConfirmationDigest = typeof ConfirmationDigest.Type;

const confirmationCommandPrefix = "CONFIRMAR ";
const challengeCommandPrefix = "Responde exactamente: ";

/** Renders the one host-owned framing shared by every exact confirmation challenge. */
export const renderConfirmationChallengeText = (input: {
  readonly challengeBody: string;
  readonly commandPrefix: string;
  readonly digest: ConfirmationDigest;
}): string =>
  `${input.challengeBody}\n${challengeCommandPrefix}${input.commandPrefix}${input.digest}`;

/** Extracts a complete command only from the final host-owned challenge line. */
export const confirmationCommandFromChallenge = (text: string): Option.Option<string> =>
  Option.fromUndefinedOr(text.split("\n").at(-1)).pipe(
    Option.filter((line) => line.startsWith(challengeCommandPrefix)),
    Option.map((line) => line.slice(challengeCommandPrefix.length))
  );

/** Extracts a digest only from one complete confirmation command. */
export const confirmationDigestFromCommand = (text: string): Option.Option<ConfirmationDigest> => {
  const command = text.trim();
  const digestSeparator = command.lastIndexOf(" ");
  if (
    !command.startsWith(confirmationCommandPrefix) ||
    digestSeparator < confirmationCommandPrefix.length
  ) {
    return Option.none();
  }
  return Schema.decodeOption(ConfirmationDigest)(command.slice(digestSeparator + 1));
};

/** Extracts the exact command digest only from a complete host-rendered challenge. */
export const confirmationDigestFromChallenge = (text: string): Option.Option<ConfirmationDigest> =>
  confirmationCommandFromChallenge(text).pipe(Option.flatMap(confirmationDigestFromCommand));

/**
 * Single-use authority to execute exactly one confirmed canonical call. It lives beside the digest
 * so the canonical execution boundary can require a permit without importing the confirmation
 * workflow that issues one.
 */
export type ConfirmationPermitConsumption = Readonly<{
  confirmed: boolean;
  evidence: Option.Option<ProviderQualifiedMessages>;
}>;

export type ConfirmationPermit = Readonly<{
  consume: (input: {
    readonly binding: Readonly<AgentOperationBinding>;
    readonly canonicalInput: SchemaNamespace.Json;
  }) => Effect.Effect<ConfirmationPermitConsumption, never, SqlClient.SqlClient>;
}>;
