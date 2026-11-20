import fixtureUpload from "./native-fixture-upload.json" with { type: "json" };
import retainedProvider from "./native-retained-provider.json" with { type: "json" };
import { Config, Data, Effect, Redacted } from "effect";

import { Hex } from "effect/encoding";

export const fixtureBuild = Config.Literals(["ordinary", "fallback"], "NATIVE_FIXTURE_BUILD").pipe(
  Config.withDefault("ordinary")
);
export const fixtureSuccessorPlan = Effect.gen(function* () {
  const operation = yield* Config.String("FIXTURE_RELEASE_OPERATION").pipe(Config.withDefault(""));
  return operation === "plan-fixture-successor";
});
const workerFiles = {
  ordinary: { Core: "core-worker", Ingress: "public-worker" },
  fallback: { Core: "fixture-fallback-core", Ingress: "fixture-fallback-ingress" },
};
export const receiptWorkerMain = ({
  role,
  fallback,
}: {
  role: "Core" | "Ingress";
  fallback: boolean;
}): string =>
  "../../apps/server/cloudflare/" + workerFiles[fallback ? "fallback" : "ordinary"][role] + ".ts";

export const resourceRevision = ({
  revision,
  signed,
}: {
  revision: string;
  signed: boolean;
}): string => (signed ? fixtureUpload.revision : revision);

export const expectedFixtureSigner = Config.String("NATIVE_FIXTURE_SIGNER_SHA256").pipe(
  Config.withDefault("")
);

type SignerBindings = Partial<
  Readonly<{
    ACCEPTANCE_PROVIDER_REVISION: string;
    NATIVE_FIXTURE_MEMBER: "performance-2";
    NATIVE_FIXTURE_SIGNING_KEY: Redacted.Redacted<string>;
    NATIVE_FIXTURE_SIGNER_SHA256: string;
  }>
>;
class InvalidFixtureSigner extends Data.TaggedError("InvalidFixtureSigner") {}
const keyOperation = <A>(run: () => Promise<A>): Effect.Effect<A, InvalidFixtureSigner> =>
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
  successorPlan: boolean;
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
  return {
    ACCEPTANCE_PROVIDER_REVISION: retainedProvider.revision,
    ...(release.successorPlan ? { NATIVE_FIXTURE_MEMBER: "performance-2" as const } : {}),
    NATIVE_FIXTURE_SIGNING_KEY: secret,
    NATIVE_FIXTURE_SIGNER_SHA256: fingerprint,
  };
});

export const fixtureArtifacts = Effect.fn(function* (revision: string) {
  const retainProvider = (yield* expectedFixtureSigner) !== "";
  const fallback = (yield* fixtureBuild) === "fallback";
  const successorPlan = yield* fixtureSuccessorPlan;
  if ((fallback || successorPlan) && !retainProvider) {
    return yield* Effect.die(Error("Dormant fixture requires the protected retained provider"));
  }
  return {
    fallback: fallback || successorPlan,
    retainProvider,
    successorPlan,
    resourceRevision: successorPlan
      ? revision
      : resourceRevision({ revision, signed: retainProvider }),
    supportRevision: resourceRevision({ revision, signed: retainProvider }),
  };
});
