import fixtureUpload from "./native-fixture-upload.json" with { type: "json" };
import retainedProvider from "./native-retained-provider.json" with { type: "json" };
import { Config, Data, Effect, Redacted, Result } from "effect";

import { Hex } from "effect/encoding";
import { fileURLToPath } from "node:url";

export const fixtureBuild = Config.Literals(["ordinary", "fallback"], "NATIVE_FIXTURE_BUILD").pipe(
  Config.withDefault("ordinary")
);

const successorOperations: ReadonlySet<string> = new Set([
  "plan-fixture-successor",
  "stage-fixture-successor",
  "recover-fixture-successor",
  "rollout-fixture-successor",
]);

export const accountingFixture = {
  revision: "de04a192c3836be0efb488b170a7b93b9f98f28f",
  contractDigest: "7a998d31ff69335d7c90bef16407af1a772cf00aab9e44e23d6c2c357857618f",
} as const;

export const stagedAccountingRevision = "c85cb1574464a8d00223f80c48a83f55efd61958";

export const nativeSmokeMain = "../../apps/server/cloudflare/release-smoke-worker.ts";

const accountingRolloutEnabled = Config.Boolean("FIXTURE_ACCOUNTING_ROLLOUT").pipe(
  Config.withDefault(false)
);

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

export const accountingWorkerMain = (role: "Core" | "Ingress"): string =>
  fileURLToPath(new URL(receiptWorkerMain({ role, fallback: false }), import.meta.url));

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

  if (Result.isFailure(decoded)) return yield* new InvalidFixtureSigner();

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

  if (!release.successorPlan) {
    return {
      ACCEPTANCE_PROVIDER_REVISION: retainedProvider.revision,
      NATIVE_FIXTURE_SIGNING_KEY: secret,
      NATIVE_FIXTURE_SIGNER_SHA256: fingerprint,
    };
  }

  return {
    ACCEPTANCE_PROVIDER_REVISION: retainedProvider.revision,
    NATIVE_FIXTURE_MEMBER: "performance-2" as const,
    NATIVE_FIXTURE_SIGNING_KEY: secret,
    NATIVE_FIXTURE_SIGNER_SHA256: fingerprint,
  };
});

const requireAccountingRollout = Effect.fn(function* (revision: string) {
  yield* Config.Literal("rollout-fixture-successor", "FIXTURE_RELEASE_OPERATION");
  yield* Config.Literal("closed", "NATIVE_STORAGE_ADMISSION");
  yield* Config.Literal("acceptance", "NATIVE_STORAGE_HOSTS");
  yield* Config.Literal(accountingFixture.contractDigest, "CONTRACT_DIGEST");
  yield* Config.Literal("true", "GITHUB_ACTIONS");
  yield* Config.Literal("true", "GITHUB_REF_PROTECTED");
  yield* Config.Literal("refs/heads/trunk", "GITHUB_REF");
  yield* Config.Literal("B4rz99/fidy-ai", "GITHUB_REPOSITORY");
  const verifier = yield* Config.String("GITHUB_SHA");

  const resuming = yield* Config.Literals(
    ["true", "false"],
    "FIXTURE_ACCOUNTING_CONTINUATION"
  ).pipe(Config.withDefault("false"));

  if (resuming === "true") {
    yield* Config.Literal(
      "B4rz99/fidy-ai/.github/workflows/native-fixture-successor-plan.yml@refs/heads/trunk",
      "GITHUB_WORKFLOW_REF"
    );
    yield* Config.Literal(verifier, "FIXTURE_STAGED_VERIFIER_SHA");
    yield* Config.Literal("1", "GITHUB_RUN_ATTEMPT");
  }

  const application = resuming === "true" ? stagedAccountingRevision : verifier;

  if (
    !/^[a-f0-9]{40}$/u.test(verifier) ||
    revision !== application ||
    revision === accountingFixture.revision
  ) {
    return yield* Effect.die(
      Error("Accounting rollout requires the current verifier as app source")
    );
  }
});

const requireSignupOpening = Effect.fn(function* (revision: string) {
  yield* Config.Literal("open", "NATIVE_STORAGE_ADMISSION");
  yield* Config.Literal("staged", "NATIVE_STORAGE_HOSTS");
  yield* Config.Literal("true", "GITHUB_ACTIONS");
  yield* Config.Literal("true", "GITHUB_REF_PROTECTED");
  yield* Config.Literal("refs/heads/trunk", "GITHUB_REF");
  yield* Config.Literal("workflow_dispatch", "GITHUB_EVENT_NAME");
  yield* Config.Literal("1", "GITHUB_RUN_ATTEMPT");
  yield* Config.Literal(revision, "GITHUB_SHA");
  yield* Config.Literal(
    "B4rz99/fidy-ai/.github/workflows/native-storage-release.yml@refs/heads/trunk",
    "GITHUB_WORKFLOW_REF"
  );
});

const closedFixtureArtifacts = Effect.fn(function* (revision: string, operation: string) {
  const retainProvider = (yield* expectedFixtureSigner) !== "";
  const accountingRollout = yield* accountingRolloutEnabled;

  if (accountingRollout) yield* requireAccountingRollout(revision);
  const successorPlan = successorOperations.has(operation);

  const fallback = successorPlan
    ? operation !== "rollout-fixture-successor"
    : (yield* fixtureBuild) === "fallback";

  if ((fallback || successorPlan) && !retainProvider) {
    return yield* Effect.die(Error("Dormant fixture requires the protected retained provider"));
  }

  const supportRevision = resourceRevision({ revision, signed: retainProvider });
  const generation = successorPlan ? revision : supportRevision;

  return {
    fallback,
    retainProvider,
    successorPlan,
    accountingRollout,
    signupOpening: false,
    resourceRevision: accountingRollout ? accountingFixture.revision : generation,
    supportRevision,
  };
});

export const fixtureArtifacts = Effect.fn(function* (revision: string) {
  const operation = yield* Config.String("FIXTURE_RELEASE_OPERATION").pipe(Config.withDefault(""));

  if (operation === "open-canonical-signup") {
    yield* requireSignupOpening(revision);

    return {
      fallback: false,
      retainProvider: true,
      successorPlan: false,
      accountingRollout: false,
      signupOpening: true,
      resourceRevision: accountingFixture.revision,
      supportRevision: fixtureUpload.revision,
    };
  }

  return yield* closedFixtureArtifacts(revision, operation);
});
