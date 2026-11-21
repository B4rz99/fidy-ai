import { Effect, Option, Redacted, Schema } from "effect";
import { Base64Url } from "effect/encoding";
import {
  ConnectionAuthorizationUnavailable,
  type ConnectionBankPreparation,
  ConnectionConsentIntent,
} from "../contract";

const entropyBytes = 32;

type Proof = Readonly<{
  verifier: Redacted.Redacted<string>;
  state: string;
  challenge: string;
  stateDigest: string;
}>;

export const prepareProof = (
  bank: Option.Option<ConnectionBankPreparation>
): Effect.Effect<Option.Option<Proof>, ConnectionAuthorizationUnavailable> => {
  if (Option.isNone(bank)) return Effect.succeedNone;

  return Effect.gen(function* () {
    const secret = (): string =>
      Base64Url.encode(crypto.getRandomValues(new Uint8Array(entropyBytes)));

    const values = yield* Effect.try({
      try: () => ({ verifier: secret(), state: secret() }),
      catch: (cause) => new ConnectionAuthorizationUnavailable({ cause }),
    });

    const hash = (value: string): Effect.Effect<string, ConnectionAuthorizationUnavailable> =>
      Effect.tryPromise({
        try: () =>
          crypto.subtle
            .digest("SHA-256", new TextEncoder().encode(value))
            .then((bytes) => Base64Url.encode(new Uint8Array(bytes))),
        catch: (cause) => new ConnectionAuthorizationUnavailable({ cause }),
      });

    return Option.some({
      verifier: Redacted.make(values.verifier),
      state: values.state,
      challenge: yield* hash(values.verifier),
      stateDigest: yield* hash(values.state),
    });
  });
};

export const encodeConsentIntent = (
  bank: Option.Option<ConnectionBankPreparation>
): Effect.Effect<string, ConnectionAuthorizationUnavailable> =>
  Option.isNone(bank)
    ? Effect.succeed("{}")
    : Schema.encodeEffect(Schema.fromJsonString(ConnectionConsentIntent))(bank.value.intent).pipe(
        Effect.mapError((cause) => new ConnectionAuthorizationUnavailable({ cause }))
      );
