import { Crypto, Effect, Option, Redacted, Result, Schema } from "effect";
import { Base64Url } from "effect/encoding";
import { ConnectionAuthorizationUnavailable, type ConnectionBankGrant } from "../contract";

const keyLength = 32;
const nonceLength = 12;
const EncodedKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u));
const Grant = Schema.Struct({
  accessToken: Schema.OptionFromNullOr(Schema.String),
  refreshToken: Schema.OptionFromNullOr(Schema.String),
  expiresAtMilliseconds: Schema.Int,
});

export const decodeGrantKey = (
  key: Redacted.Redacted<string>
): Effect.Effect<Uint8Array, ConnectionAuthorizationUnavailable> =>
  Effect.gen(function* () {
    const encoded = yield* Schema.decodeEffect(EncodedKey)(Redacted.value(key));
    const bytes = Base64Url.decode(encoded);
    if (
      Result.isFailure(bytes) ||
      bytes.success.length !== keyLength ||
      Base64Url.encode(bytes.success) !== encoded
    ) {
      return yield* new ConnectionAuthorizationUnavailable();
    }
    return bytes.success;
  }).pipe(Effect.mapError(() => new ConnectionAuthorizationUnavailable()));

export const sealGrant = (
  input: Readonly<{ key: Redacted.Redacted<string>; purpose: string; grant: ConnectionBankGrant }>
): Effect.Effect<string, ConnectionAuthorizationUnavailable, Crypto.Crypto> =>
  Effect.gen(function* () {
    const bytes = yield* decodeGrantKey(input.key);
    const plaintext = yield* Schema.encodeEffect(Schema.fromJsonString(Grant))({
      accessToken: Option.map(input.grant.accessToken, Redacted.value),
      refreshToken: Option.map(input.grant.refreshToken, Redacted.value),
      expiresAtMilliseconds: input.grant.expiresAtMilliseconds,
    });
    const entropy = yield* Crypto.Crypto;
    const nonce = yield* entropy.randomBytes(nonceLength);
    return yield* Effect.tryPromise({
      try: () =>
        crypto.subtle
          .importKey("raw", Uint8Array.from(bytes), "AES-GCM", false, ["encrypt"])
          .then((key) => {
            const iv = Uint8Array.from(nonce);
            return crypto.subtle
              .encrypt(
                { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(input.purpose) },
                key,
                new TextEncoder().encode(plaintext)
              )
              .then(
                (ciphertext) =>
                  `v1.${Base64Url.encode(iv)}.${Base64Url.encode(new Uint8Array(ciphertext))}`
              );
          }),
      catch: () => new ConnectionAuthorizationUnavailable(),
    });
  }).pipe(Effect.mapError(() => new ConnectionAuthorizationUnavailable()));

export const openGrant = (
  input: Readonly<{ key: Redacted.Redacted<string>; purpose: string; envelope: string }>
): Effect.Effect<ConnectionBankGrant, ConnectionAuthorizationUnavailable> =>
  Effect.gen(function* () {
    const bytes = yield* decodeGrantKey(input.key);
    const parts = input.envelope.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") {
      return yield* new ConnectionAuthorizationUnavailable();
    }
    const nonce = Base64Url.decode(parts[1] ?? "");
    const ciphertext = Base64Url.decode(parts[2] ?? "");
    if (
      Result.isFailure(nonce) ||
      nonce.success.length !== nonceLength ||
      Result.isFailure(ciphertext)
    ) {
      return yield* new ConnectionAuthorizationUnavailable();
    }
    const plaintext = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle
          .importKey("raw", Uint8Array.from(bytes), "AES-GCM", false, ["decrypt"])
          .then((key) =>
            crypto.subtle.decrypt(
              {
                name: "AES-GCM",
                iv: Uint8Array.from(nonce.success),
                additionalData: new TextEncoder().encode(input.purpose),
              },
              key,
              Uint8Array.from(ciphertext.success)
            )
          )
          .then((decrypted) => new TextDecoder().decode(decrypted)),
      catch: () => new ConnectionAuthorizationUnavailable(),
    });
    const grant = yield* Schema.decodeEffect(Schema.fromJsonString(Grant))(plaintext);
    return {
      ...grant,
      accessToken: Option.map(grant.accessToken, Redacted.make),
      refreshToken: Option.map(grant.refreshToken, Redacted.make),
    };
  }).pipe(Effect.mapError(() => new ConnectionAuthorizationUnavailable()));

export const grantPurpose = (
  input: Readonly<{
    userId: string;
    connectionId: string;
    attemptId: string;
    clientId: string;
    consentId: string;
    intentJson: string;
  }>
): Effect.Effect<string> =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))([
    "fidy-bank-grant-v1",
    input.userId,
    input.connectionId,
    input.attemptId,
    "bancolombia",
    "sandbox",
    input.clientId,
    input.consentId,
    input.intentJson,
  ]).pipe(Effect.orDie);
