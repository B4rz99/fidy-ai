import { Buffer } from "node:buffer";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { Config, Effect, Redacted } from "effect";

export const expectedFixtureSigner = Config.String("NATIVE_FIXTURE_SIGNER_SHA256").pipe(
  Config.withDefault("")
);

type SignerBindings = Partial<
  Readonly<{
    NATIVE_FIXTURE_SIGNING_KEY: Redacted.Redacted<string>;
    NATIVE_FIXTURE_SIGNER_SHA256: string;
  }>
>;
const publicFingerprint = (value: string): string => {
  if (!/^(?:[0-9a-f]{2}){32,512}$/u.test(value)) throw Error("Invalid candidate signer encoding");
  const key = createPrivateKey({ key: Buffer.from(value, "hex"), format: "der", type: "pkcs8" });
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw Error("Candidate requires P-256 signing material");
  }
  return createHash("sha256")
    .update(createPublicKey(key).export({ format: "der", type: "spki" }))
    .digest("hex");
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
  const actual = yield* Effect.try({
    try: () => publicFingerprint(value),
    catch: () => Error("Invalid candidate signing key"),
  });
  if (actual !== fingerprint) {
    return yield* Effect.fail(Error("Candidate signing key fingerprint mismatch"));
  }
  return { NATIVE_FIXTURE_SIGNING_KEY: secret, NATIVE_FIXTURE_SIGNER_SHA256: fingerprint };
});
