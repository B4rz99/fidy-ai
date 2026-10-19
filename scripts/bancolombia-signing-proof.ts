import { BunCrypto } from "@effect/platform-bun";
import { Config, Crypto, Data, Effect, Redacted, Result, Schema } from "effect";
import { Base64, Base64Url } from "effect/encoding";

const maximumJwksBytes = 16384;
const maximumPemCharacters = 10000;
const challengeBytes = 32;
const signingKey = Schema.Struct({
  kty: Schema.Literal("RSA"),
  alg: Schema.Literal("RS256"),
  use: Schema.Literal("sig"),
  kid: Schema.String,
  n: Schema.String,
  e: Schema.String,
});
const jwksSchema = Schema.fromJsonString(Schema.Struct({ keys: Schema.Tuple([signingKey]) }));
const proofSchema = Schema.fromJsonString(
  Schema.Struct({
    status: Schema.Literal("verified"),
    kid: Schema.String,
    thumbprint: Schema.String,
    algorithm: Schema.Literal("RS256"),
  })
);
const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

class SigningProofFailure extends Data.TaggedError("SigningProofFailure")<{
  reason: "InvalidPublicKey" | "InvalidPrivateKey" | "KeyMismatch" | "CryptoUnavailable";
}> {}

const importPrivateKey = Effect.fn(function* (material: Redacted.Redacted<string>) {
  const pem = Redacted.value(material);
  if (pem.length > maximumPemCharacters) {
    return yield* new SigningProofFailure({ reason: "InvalidPrivateKey" });
  }
  const match =
    /^-----BEGIN PRIVATE KEY-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END PRIVATE KEY-----\s*$/u.exec(
      pem
    );
  const encoded = match?.[1];
  if (encoded === undefined) return yield* new SigningProofFailure({ reason: "InvalidPrivateKey" });
  const decoded = Base64.decode(encoded);
  if (Result.isFailure(decoded)) {
    return yield* new SigningProofFailure({ reason: "InvalidPrivateKey" });
  }
  return yield* Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey("pkcs8", Uint8Array.from(decoded.success).buffer, algorithm, false, [
        "sign",
      ]),
    catch: () => new SigningProofFailure({ reason: "InvalidPrivateKey" }),
  });
});

/** Proves RS256 possession for the pinned public identity; returns no signature or challenge. */
export const proveSigningKey = Effect.fn(function* (
  input: Readonly<{
    expected: Readonly<{ kid: string; thumbprint: string }>;
    jwks: string;
    privateKey: Redacted.Redacted<string>;
  }>
) {
  if (new TextEncoder().encode(input.jwks).byteLength > maximumJwksBytes) {
    return yield* new SigningProofFailure({ reason: "InvalidPublicKey" });
  }
  const {
    keys: [key],
  } = yield* Schema.decodeEffect(jwksSchema, { onExcessProperty: "error" })(input.jwks).pipe(
    Effect.mapError(() => new SigningProofFailure({ reason: "InvalidPublicKey" }))
  );
  const cryptoService = yield* Crypto.Crypto;
  const canonicalJson = yield* Schema.encodeEffect(
    Schema.fromJsonString(
      Schema.Struct({ e: Schema.String, kty: Schema.Literal("RSA"), n: Schema.String })
    )
  )({ e: key.e, kty: key.kty, n: key.n }).pipe(
    Effect.mapError(() => new SigningProofFailure({ reason: "InvalidPublicKey" }))
  );
  const canonical = new TextEncoder().encode(canonicalJson);
  const digest = yield* cryptoService
    .digest("SHA-256", canonical)
    .pipe(Effect.mapError(() => new SigningProofFailure({ reason: "CryptoUnavailable" })));
  const thumbprint = Base64Url.encode(digest);
  if (key.kid !== input.expected.kid || thumbprint !== input.expected.thumbprint) {
    return yield* new SigningProofFailure({ reason: "InvalidPublicKey" });
  }
  const privateKey = yield* importPrivateKey(input.privateKey);
  const publicKey = yield* Effect.tryPromise({
    try: () => crypto.subtle.importKey("jwk", key, algorithm, false, ["verify"]),
    catch: () => new SigningProofFailure({ reason: "InvalidPublicKey" }),
  });
  const random = yield* cryptoService
    .randomBytes(challengeBytes)
    .pipe(Effect.mapError(() => new SigningProofFailure({ reason: "CryptoUnavailable" })));
  const challenge = new TextEncoder().encode(
    "Fidy signing possession proof #1266\n" + Base64Url.encode(random)
  );
  const signature = yield* Effect.tryPromise({
    try: () => crypto.subtle.sign(algorithm, privateKey, challenge),
    catch: () => new SigningProofFailure({ reason: "CryptoUnavailable" }),
  });
  const verified = yield* Effect.tryPromise({
    try: () => crypto.subtle.verify(algorithm, publicKey, signature, challenge),
    catch: () => new SigningProofFailure({ reason: "CryptoUnavailable" }),
  });
  if (!verified) return yield* new SigningProofFailure({ reason: "KeyMismatch" });
  return { status: "verified" as const, kid: key.kid, thumbprint, algorithm: "RS256" as const };
});

const program = Effect.gen(function* () {
  const path = yield* Config.NonEmptyString("FIDY_BANCOLOMBIA_JWKS_FILE");
  const jwks = yield* Effect.tryPromise(() =>
    Bun.file(path)
      .slice(0, maximumJwksBytes + 1)
      .text()
  );
  const privateKey = yield* Config.Redacted("BANCOLOMBIA_SANDBOX_PRIVATE_KEY_PEM");
  const proof = yield* proveSigningKey({
    jwks,
    privateKey,
    expected: {
      kid: "bancolombia-sandbox-2026-10-08",
      thumbprint: "j1s582zfiR_-eKowck-EajaZmu5oZqx7jPgJtUhy2QE",
    },
  });
  const output = yield* Schema.encodeEffect(proofSchema)(proof);
  process.stdout.write(output + "\n");
});

if (import.meta.main) {
  await Effect.runPromise(
    program.pipe(
      Effect.provide(BunCrypto.layer),
      Effect.catchCause(() =>
        Effect.sync(() => {
          process.stderr.write('{"error":"SigningProofUnavailable"}\n');
          process.exitCode = 1;
        })
      )
    )
  );
}
