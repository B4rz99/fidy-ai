import { BunCrypto, BunFileSystem } from "@effect/platform-bun";
import { layer } from "@effect/vitest";
import { Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import { Base64, Base64Url } from "effect/encoding";
import { expect } from "vitest";
import { proveSigningKey } from "./bancolombia-signing-proof";

const privatePem = (body: string): Redacted.Redacted<string> => {
  const label = "PRIVATE KEY";
  return Redacted.make([`-----BEGIN ${label}-----`, body, `-----END ${label}-----`].join("\n"));
};

const fixture = Effect.gen(function* () {
  const pair = yield* Effect.tryPromise(() =>
    crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"]
    )
  );
  const publicKey = yield* Effect.tryPromise(() => crypto.subtle.exportKey("jwk", pair.publicKey));
  const privateBytes = yield* Effect.tryPromise(() =>
    crypto.subtle.exportKey("pkcs8", pair.privateKey)
  );
  const canonical = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    e: publicKey.e,
    kty: "RSA",
    n: publicKey.n,
  });
  const hash = yield* Effect.tryPromise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))
  );
  const expected = {
    kid: "synthetic-proof-key",
    thumbprint: Base64Url.encode(new Uint8Array(hash)),
  };
  return {
    expected,
    jwks: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      keys: [
        { kty: "RSA", alg: "RS256", use: "sig", kid: expected.kid, n: publicKey.n, e: publicKey.e },
      ],
    }),
    privateKey: privatePem(Base64.encode(new Uint8Array(privateBytes))),
  };
});

layer(Layer.mergeAll(BunCrypto.layer, BunFileSystem.layer), { excludeTestServices: true })((it) => {
  it.effect(
    "proves matching signing possession without returning private material or a reusable assertion",
    () =>
      Effect.gen(function* () {
        const input = yield* fixture;
        const proof = yield* proveSigningKey(input);
        expect(proof).toEqual({
          status: "verified",
          kid: input.expected.kid,
          thumbprint: input.expected.thumbprint,
          algorithm: "RS256",
        });
      })
  );

  it.effect("refuses a different private key with only a closed mismatch failure", () =>
    Effect.gen(function* () {
      const input = yield* fixture;
      const other = yield* fixture;
      const failure = yield* proveSigningKey({ ...input, privateKey: other.privateKey }).pipe(
        Effect.flip
      );
      expect(failure).toMatchObject({ _tag: "SigningProofFailure", reason: "KeyMismatch" });
    })
  );

  it.effect(
    "rejects unpinned or private-bearing public metadata before using signing authority",
    () =>
      Effect.gen(function* () {
        const input = yield* fixture;
        for (const jwks of [
          input.jwks.replace(input.expected.kid, "unregistered-key"),
          input.jwks.replace('"use":"sig"', '"use":"sig","d":"forbidden-private-material"'),
          '{"keys":[]}',
          "x".repeat(16385),
        ]) {
          const failure = yield* proveSigningKey({ ...input, jwks }).pipe(Effect.flip);
          expect(failure).toMatchObject({
            _tag: "SigningProofFailure",
            reason: "InvalidPublicKey",
          });
        }
        const failure = yield* proveSigningKey({
          ...input,
          expected: { ...input.expected, thumbprint: "unregistered-thumbprint" },
        }).pipe(Effect.flip);
        expect(failure).toMatchObject({ _tag: "SigningProofFailure", reason: "InvalidPublicKey" });
      })
  );

  it.effect("keeps malformed private material out of its failure projection", () =>
    Effect.gen(function* () {
      const input = yield* fixture;
      for (const privateKey of [
        Redacted.make("not-a-private-key"),
        privatePem("AAAA"),
        Redacted.make("x".repeat(10001)),
      ]) {
        const failure = yield* proveSigningKey({ ...input, privateKey }).pipe(Effect.flip);
        expect(Object.keys(failure).sort()).toEqual(["_tag", "reason"]);
        expect(failure.reason).toBe("InvalidPrivateKey");
      }
    })
  );

  it.effect(
    "emits only a fixed failure and exits nonzero when protected configuration is unavailable",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const path = directory + "/public-jwks.json";
        yield* fs.writeFileString(path, '{"keys":[]}');
        const child = yield* Effect.try(() =>
          Bun.spawnSync(
            [process.execPath, new URL("./bancolombia-signing-proof.ts", import.meta.url).pathname],
            { env: { FIDY_BANCOLOMBIA_JWKS_FILE: path }, stdout: "pipe", stderr: "pipe" }
          )
        );
        expect(child.exitCode).toBe(1);
        expect(new TextDecoder().decode(child.stdout)).toBe("");
        expect(new TextDecoder().decode(child.stderr)).toBe(
          '{"error":"SigningProofUnavailable"}\n'
        );
      })
  );
});
