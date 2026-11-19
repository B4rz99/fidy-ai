import { Config, Data, Effect, Redacted } from "effect";

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
class InvalidFixtureSigner extends Data.TaggedError("InvalidFixtureSigner") {}
const keyOperation = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: () => new InvalidFixtureSigner() });
const publicFingerprint = Effect.fnUntraced(function* (value: string) {
  const decoded = Hex.decode(value);
  if (decoded._tag === "Failure") return yield* new InvalidFixtureSigner();
  const algorithm = { name: "ECDSA", namedCurve: "P-256" };
  const key = yield* keyOperation(() =>
    crypto.subtle.importKey("pkcs8", Uint8Array.from(decoded.success), algorithm, true, ["sign"])
  );
  const { x, y } = yield* keyOperation(() => crypto.subtle.exportKey("jwk", key));
  const publicKey = yield* keyOperation(() =>
    crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x, y }, algorithm, true, ["verify"])
  );
  const der = yield* keyOperation(() => crypto.subtle.exportKey("spki", publicKey));
  return Hex.encode(
    new Uint8Array(yield* keyOperation(() => crypto.subtle.digest("SHA-256", der)))
  );
});
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
  if (value === "" && fingerprint === "") return disabled;
  if (!release.closed || release.hosts !== "acceptance" || !/^[a-f0-9]{64}$/u.test(fingerprint)) {
    return yield* Effect.fail(
      Error("A receipt signer requires a pinned closed acceptance candidate")
    );
  }
  const actual = yield* publicFingerprint(value);
  if (actual !== fingerprint) {
    return yield* Effect.fail(Error("Candidate signing key fingerprint mismatch"));
  }
  return { NATIVE_FIXTURE_SIGNING_KEY: secret, NATIVE_FIXTURE_SIGNER_SHA256: fingerprint };
});
