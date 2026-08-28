import assert from "node:assert/strict";
import { expect, it } from "@effect/vitest";
import { ConfigProvider, Data, DateTime, Effect, Layer, Redacted, Result } from "effect";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import {
  SupportAccessUnauthorized,
  SupportAccessUnavailable,
  SupportAccessVerifier,
  makeSupportAccessVerifier,
} from "./access";

class TestCryptoFailure extends Data.TaggedError("TestCryptoFailure")<{}> {}

const issuer = "https://fidy.cloudflareaccess.com";
const audience = "support-recovery-audience";
const secondsPerMinute = 60;
const millisecondsPerSecond = 1_000;
const futureIssuedAtMinutes = 60;
const assertionLifetimeMinutes = 15;

type SigningInput = Readonly<{
  privateKey: CryptoKey;
  subject: string;
  tokenAudience: string;
}>;

const accessToken = (input: SigningInput): SignJWT =>
  new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "support-key" })
    .setIssuer(issuer)
    .setAudience(input.tokenAudience)
    .setSubject(input.subject)
    .setIssuedAt();

const sign = (input: SigningInput & { readonly expiration: string }): Effect.Effect<string> =>
  Effect.tryPromise({
    try: () => accessToken(input).setExpirationTime(input.expiration).sign(input.privateKey),
    catch: () => new TestCryptoFailure(),
  }).pipe(Effect.orDie);

const signWithoutExpiration = (input: SigningInput): Effect.Effect<string> =>
  Effect.tryPromise({
    try: () => accessToken(input).sign(input.privateKey),
    catch: () => new TestCryptoFailure(),
  }).pipe(Effect.orDie);

const signFutureDated = (input: SigningInput): Effect.Effect<string> =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const issuedAt =
      Math.floor(now.epochMilliseconds / millisecondsPerSecond) +
      futureIssuedAtMinutes * secondsPerMinute;
    return yield* Effect.tryPromise({
      try: () =>
        accessToken(input)
          .setIssuedAt(issuedAt)
          .setExpirationTime(issuedAt + assertionLifetimeMinutes * secondsPerMinute)
          .sign(input.privateKey),
      catch: () => new TestCryptoFailure(),
    }).pipe(Effect.orDie);
  });

const signWithoutIssuedAt = (input: SigningInput): Effect.Effect<string> =>
  Effect.tryPromise({
    try: () =>
      new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: "support-key" })
        .setIssuer(issuer)
        .setAudience(input.tokenAudience)
        .setSubject(input.subject)
        .setExpirationTime("15m")
        .sign(input.privateKey),
    catch: () => new TestCryptoFailure(),
  }).pipe(Effect.orDie);

it.effect("fails startup closed for missing or malformed Access configuration", () =>
  Effect.gen(function* () {
    const invalidEnvironments: ReadonlyArray<Record<string, string>> = [
      {},
      {
        CLOUDFLARE_ACCESS_ISSUER: "http://not-access.example",
        CLOUDFLARE_ACCESS_AUDIENCE: audience,
      },
      { CLOUDFLARE_ACCESS_ISSUER: issuer, CLOUDFLARE_ACCESS_AUDIENCE: "" },
    ];
    for (const environment of invalidEnvironments) {
      const built = yield* Effect.result(
        Effect.scoped(Layer.build(SupportAccessVerifier.layer)).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnv({ env: environment })
          )
        )
      );
      expect(Result.isFailure(built)).toBe(true);
    }
  })
);

it.live("verifies signature and exact Access claims before constructing SupportOperatorId", () =>
  Effect.gen(function* () {
    const pair = yield* Effect.tryPromise({
      try: () => generateKeyPair("RS256"),
      catch: () => new TestCryptoFailure(),
    }).pipe(Effect.orDie);
    const jwk = yield* Effect.tryPromise({
      try: () => exportJWK(pair.publicKey),
      catch: () => new TestCryptoFailure(),
    }).pipe(Effect.orDie);
    const verifier = makeSupportAccessVerifier({
      issuer,
      audience,
      jwks: createLocalJWKSet({ keys: [{ ...jwk, kid: "support-key", alg: "RS256" }] }),
    });

    const accepted = yield* verifier.verify(
      Redacted.make(
        yield* sign({
          privateKey: pair.privateKey,
          subject: "operator-42",
          tokenAudience: audience,
          expiration: "15m",
        })
      )
    );
    expect(accepted).toEqual({ issuer, subject: "operator-42" });

    for (const token of [
      yield* sign({
        privateKey: pair.privateKey,
        subject: "operator-42",
        tokenAudience: "wrong-audience",
        expiration: "15m",
      }),
      yield* sign({
        privateKey: pair.privateKey,
        subject: "",
        tokenAudience: audience,
        expiration: "15m",
      }),
      yield* sign({
        privateKey: pair.privateKey,
        subject: "operator-42",
        tokenAudience: audience,
        expiration: "16m",
      }),
      yield* sign({
        privateKey: pair.privateKey,
        subject: "operator-42",
        tokenAudience: audience,
        expiration: "0s",
      }),
      yield* signWithoutExpiration({
        privateKey: pair.privateKey,
        subject: "operator-42",
        tokenAudience: audience,
      }),
      yield* signFutureDated({
        privateKey: pair.privateKey,
        subject: "operator-42",
        tokenAudience: audience,
      }),
      yield* signWithoutIssuedAt({
        privateKey: pair.privateKey,
        subject: "operator-42",
        tokenAudience: audience,
      }),
    ]) {
      const result = yield* Effect.result(verifier.verify(Redacted.make(token)));
      assert.ok(Result.isFailure(result));
      expect(result.failure).toBeInstanceOf(SupportAccessUnauthorized);
    }

    const unavailableVerifier = makeSupportAccessVerifier({
      issuer,
      audience,
      jwks: () => Promise.reject(new TypeError("Access JWKS unavailable")),
    });
    const unavailable = yield* Effect.result(
      unavailableVerifier.verify(
        Redacted.make(
          yield* sign({
            privateKey: pair.privateKey,
            subject: "operator-42",
            tokenAudience: audience,
            expiration: "15m",
          })
        )
      )
    );
    assert.ok(Result.isFailure(unavailable));
    expect(unavailable.failure).toBeInstanceOf(SupportAccessUnavailable);
  })
);
