import { Config, Effect, Redacted } from "effect";

import { Hex } from "effect/encoding";

export const expectedFixtureSigner = Config.String("NATIVE_FIXTURE_SIGNER_SHA256").pipe(
  Config.withDefault("")
);

type SignerBindings = Partial<
  Readonly<{
    NATIVE_FIXTURE_SIGNING_KEY: Redacted.Redacted<string>;
    NATIVE_FIXTURE_SIGNER_SHA256: string;
  }>
>;
const publicFingerprint = async (value: string): Promise<string> => {
  const decoded = Hex.decode(value);
  if (decoded._tag === "Failure") throw Error("Invalid candidate signing key");
  const algorithm = { name: "ECDSA", namedCurve: "P-256" };
  const key = await crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(decoded.success),
    algorithm,
    true,
    ["sign"]
  );
  const { x, y } = await crypto.subtle.exportKey("jwk", key);
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x, y },
    algorithm,
    true,
    ["verify"]
  );
  const der = await crypto.subtle.exportKey("spki", publicKey);
  return Hex.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", der)));
};
export const fixtureSignerBindings = Effect.fn(function* (release: {
  closed: boolean;
  hosts: string;
}) {
  const fingerprint = yield* expectedFixtureSigner;
  const secret = yield* Config.Redacted("NATIVE_FIXTURE_SIGNING_KEY").pipe(
    Config.withDefault(Redacted.make(""))
  );
  const value = Redacted.value(secret);
  const disabled: SignerBindings = {};
  if (!value && !fingerprint) return disabled;
  if (!release.closed || release.hosts !== "acceptance" || !/^[a-f0-9]{64}$/u.test(fingerprint)) {
    return yield* Effect.fail(
      Error("A receipt signer requires a pinned closed acceptance candidate")
    );
  }
  const actual = yield* Effect.tryPromise({
    try: () => publicFingerprint(value),
    catch: () => Error("Invalid candidate signing key"),
  });
  if (actual !== fingerprint) {
    return yield* Effect.fail(Error("Candidate signing key fingerprint mismatch"));
  }
  return { NATIVE_FIXTURE_SIGNING_KEY: secret, NATIVE_FIXTURE_SIGNER_SHA256: fingerprint };
});
