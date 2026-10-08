/// <reference types="bun-types" />

import { Cause, Context, Effect, Exit, Layer, Option, Schedule, Schema } from "effect";
import { Hex } from "effect/encoding";
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest } from "effect/http";
import {
  SmokeIdentity,
  SmokeRequest,
} from "../../apps/server/cloudflare/runtime/release-smoke/contract";
import {
  CandidateRoutingPending,
  ReleaseSmokeFailed,
  checkSmokeExchange,
  exchangeSmoke,
  smokeHeaders,
} from "./smoke-exchange";
import { verifyEdgeSmoke } from "./verify-edge-smoke";

const RunnerConfig = Schema.Struct({
  RELEASE_GIT_SHA: SmokeIdentity.fields.gitRevision,
  CONTRACT_DIGEST: SmokeIdentity.fields.contractDigest,
  PUBLIC_VERSION_ID: SmokeIdentity.fields.workerVersionId,
  CORE_VERSION_ID: SmokeIdentity.fields.workerVersionId,
  STABLE_PUBLIC_VERSION_ID: SmokeIdentity.fields.workerVersionId,
  STABLE_RELEASE_GIT_SHA: SmokeIdentity.fields.gitRevision,
  STABLE_CONTRACT_DIGEST: SmokeIdentity.fields.contractDigest,
  PUBLIC_WORKER_NAME: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/u)),
  CORE_WORKER_NAME: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/u)),
  SMOKE_PROOF: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
});
type RunnerConfig = typeof RunnerConfig.Type;
const apiOrigin = "https://api.fidyapp.com";
const maxAttempts = 20;
const pollDelayMs = 1500;
const authorityRefusedStatus = 403;
const probeEntropyBytes = 16;

const candidateHeaders = (
  config: RunnerConfig,
  publicVersionId: string
): Readonly<Record<string, string>> =>
  smokeHeaders({ config, publicVersion: Option.some(publicVersionId) });

const callEdge = Effect.fn(
  function* (path: string, headers: Readonly<Record<string, string>>, body: Option.Option<string>) {
    const client = yield* HttpClient.HttpClient;
    const url = `${apiOrigin}${path}`;
    const request = Option.isSome(body)
      ? HttpClientRequest.post(url, {
          headers: { ...headers, "content-type": "application/json" },
          body: HttpBody.text(body.value, "application/json"),
        })
      : HttpClientRequest.get(url, { headers });
    const response = yield* HttpClient.withScope(client).execute(request);
    return { status: response.status, headers: new Headers(response.headers) };
  },
  Effect.scoped,
  Effect.timeout("8 seconds"),
  Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
  Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
);

const expectedPair = (
  config: RunnerConfig,
  publicIdentity: SmokeIdentity,
  replayIdentity = false
): Parameters<typeof checkSmokeExchange>[1] => ({
  public: publicIdentity,
  core: {
    gitRevision: config.RELEASE_GIT_SHA,
    contractDigest: config.CONTRACT_DIGEST,
    workerVersionId: config.CORE_VERSION_ID,
  },
  replayIdentity,
});

const awaitSyntheticWork = Effect.fn(function* (
  config: RunnerConfig,
  headers: Readonly<Record<string, string>>,
  expectedPublic: SmokeIdentity
) {
  const probeId = Hex.encode(crypto.getRandomValues(new Uint8Array(probeEntropyBytes)));
  const request = yield* Schema.encodeEffect(Schema.fromJsonString(SmokeRequest))({
    protocolVersion: 1,
    probeId,
    expectedPublicVersionId: expectedPublic.workerVersionId,
    expectedCoreVersionId: config.CORE_VERSION_ID,
    expectedGitRevision: config.RELEASE_GIT_SHA,
    expectedContractDigest: config.CONTRACT_DIGEST,
  });
  // Overrides can fall back after readiness too. Core's identity rejection precedes all
  // admission/effects; replay the same probe within the existing bound, never other failures.
  let status = yield* Effect.gen(function* () {
    const response = yield* exchangeSmoke({ query: "", headers, body: Option.some(request) });
    return yield* checkSmokeExchange(
      response,
      expectedPair(config, expectedPublic, "cloudflare-workers-version-overrides" in headers)
    );
  }).pipe(
    Effect.retry({
      times: 6,
      schedule: Schedule.spaced("1500 millis"),
      while: (error) =>
        "cloudflare-workers-version-overrides" in headers &&
        error instanceof CandidateRoutingPending,
    })
  );
  for (let attempt = 0; attempt < maxAttempts && status !== "passed"; attempt++) {
    yield* Effect.sleep(`${pollDelayMs} millis`);
    status = yield* checkSmokeExchange(
      yield* exchangeSmoke({ query: `?probeId=${probeId}`, headers, body: Option.none() }),
      expectedPair(config, expectedPublic)
    );
  }
  if (status !== "passed") {
    return yield* new ReleaseSmokeFailed({
      reason: "Synthetic Queue and Workflow probe did not complete",
    });
  }
});

const checkEdge = Effect.fn(function* (
  config: RunnerConfig,
  headers: Readonly<Record<string, string>>
) {
  const result = yield* verifyEdgeSmoke({
    probe: ({ method, path, headers: probeHeaders }) =>
      Effect.gen(function* () {
        const response = yield* callEdge(
          path,
          { ...headers, ...probeHeaders },
          method === "POST" ? Option.some("{}") : Option.none()
        );
        return response;
      }),
    candidate: Option.some({
      proof: config.SMOKE_PROOF,
      override: headers["cloudflare-workers-version-overrides"] ?? "",
      publicVersionId: config.PUBLIC_VERSION_ID,
    }),
  }).pipe(
    Effect.mapError(
      (failure) =>
        new ReleaseSmokeFailed({
          reason: `Candidate edge probe failed at ${failure.path}`,
        })
    ),
    Effect.exit
  );
  if (Exit.isFailure(result)) {
    const failure = Cause.findErrorOption(result.cause);
    return yield* Option.getOrElse(
      failure,
      () =>
        new ReleaseSmokeFailed({
          reason: "Candidate edge rejections or headers were not verified",
        })
    );
  }
});

/** Explicitly pinned HTTP invocations; a fallback to stable always fails identity comparison. */
/** Poll only proof-admitted, identity-only GETs while global routing propagates. */
export const verifyReadOnlySmokeRouting = Effect.fn(function* (
  env: unknown,
  mode: "candidate" | "intermediate" | "promoted" = "candidate"
) {
  const decoded = Schema.decodeUnknownOption(RunnerConfig)(env);
  if (Option.isNone(decoded)) {
    return yield* new ReleaseSmokeFailed({ reason: "Incomplete routing readiness configuration" });
  }
  const config = decoded.value;
  const expectedPublic =
    mode === "intermediate"
      ? {
          gitRevision: config.STABLE_RELEASE_GIT_SHA,
          contractDigest: config.STABLE_CONTRACT_DIGEST,
          workerVersionId: config.STABLE_PUBLIC_VERSION_ID,
        }
      : {
          gitRevision: config.RELEASE_GIT_SHA,
          contractDigest: config.CONTRACT_DIGEST,
          workerVersionId: config.PUBLIC_VERSION_ID,
        };
  const headers =
    mode === "promoted"
      ? smokeHeaders({ config, publicVersion: Option.none() })
      : candidateHeaders(config, expectedPublic.workerVersionId);
  let diagnostic = "No valid readiness response";
  yield* Effect.gen(function* () {
    const response = yield* exchangeSmoke({ query: "?readiness=1", headers, body: Option.none() });
    if (response.status === authorityRefusedStatus) {
      return yield* new ReleaseSmokeFailed({ reason: "Read-only routing authority refused" });
    }
    return yield* checkSmokeExchange(response, expectedPair(config, expectedPublic)).pipe(
      Effect.catch((error) => {
        diagnostic =
          error instanceof ReleaseSmokeFailed || error instanceof CandidateRoutingPending
            ? error.reason
            : "Readiness response could not be decoded";
        return new CandidateRoutingPending({ reason: diagnostic });
      })
    );
  }).pipe(
    Effect.retry({
      times: maxAttempts - 1,
      schedule: Schedule.spaced("1500 millis"),
      while: (error) => error instanceof CandidateRoutingPending,
    }),
    Effect.timeout("45 seconds"),
    Effect.catch(
      (error) =>
        new ReleaseSmokeFailed({
          reason: `Read-only ${mode} Worker routing did not converge; no synthetic work started: ${error instanceof ReleaseSmokeFailed ? error.reason : diagnostic}`,
        })
    )
  );
});

export const verifyProductionSmoke = Effect.fn(function* (env: unknown) {
  const decoded = Schema.decodeUnknownOption(RunnerConfig)(env);
  if (Option.isNone(decoded)) {
    return yield* new ReleaseSmokeFailed({ reason: "Incomplete production smoke configuration" });
  }
  const config = decoded.value;
  const headers = candidateHeaders(config, config.PUBLIC_VERSION_ID);
  // Each pairing owns a distinct probe ID. Both must pass before the caller can attest;
  // Core-first promotion still requires the exact old-public/new-Core pairing.
  yield* Effect.all(
    {
      candidate: awaitSyntheticWork(config, headers, {
        gitRevision: config.RELEASE_GIT_SHA,
        contractDigest: config.CONTRACT_DIGEST,
        workerVersionId: config.PUBLIC_VERSION_ID,
      }).pipe(
        Effect.andThen(checkEdge(config, headers)),
        Effect.mapError(
          (error) =>
            new ReleaseSmokeFailed({
              reason: `candidate pairing: ${error instanceof ReleaseSmokeFailed || error instanceof CandidateRoutingPending ? error.reason : "unclassified smoke failure"}`,
            })
        )
      ),
      intermediate: awaitSyntheticWork(
        config,
        candidateHeaders(config, config.STABLE_PUBLIC_VERSION_ID),
        {
          gitRevision: config.STABLE_RELEASE_GIT_SHA,
          contractDigest: config.STABLE_CONTRACT_DIGEST,
          workerVersionId: config.STABLE_PUBLIC_VERSION_ID,
        }
      ).pipe(
        Effect.mapError(
          (error) =>
            new ReleaseSmokeFailed({
              reason: `intermediate pairing: ${error instanceof ReleaseSmokeFailed || error instanceof CandidateRoutingPending ? error.reason : "unclassified smoke failure"}`,
            })
        )
      ),
    },
    { concurrency: 2, discard: true }
  );
});

/** Both exact pairings must be ready before either can admit synthetic work. */
export const verifyCandidateSmoke = Effect.fn(function* (env: unknown) {
  yield* Effect.all(
    [verifyReadOnlySmokeRouting(env), verifyReadOnlySmokeRouting(env, "intermediate")],
    { concurrency: 2, discard: true }
  );
  yield* verifyProductionSmoke(env);
});

/** Probe normal traffic after promotion; an exact-version override would hide a routing failure. */
export const verifyPromotedSmoke = Effect.fn(function* (env: unknown) {
  const decoded = Schema.decodeUnknownOption(RunnerConfig)(env);
  if (Option.isNone(decoded)) {
    return yield* new ReleaseSmokeFailed({
      reason: "Incomplete post-promotion smoke configuration",
    });
  }
  const config = decoded.value;
  yield* awaitSyntheticWork(config, smokeHeaders({ config, publicVersion: Option.none() }), {
    gitRevision: config.RELEASE_GIT_SHA,
    contractDigest: config.CONTRACT_DIGEST,
    workerVersionId: config.PUBLIC_VERSION_ID,
  });
});

if (import.meta.main) {
  const result = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Layer.build(FetchHttpClient.layer);
        return yield* (
          process.argv[2] === "promoted"
            ? verifyReadOnlySmokeRouting(process.env, "promoted").pipe(
                Effect.andThen(verifyPromotedSmoke(process.env))
              )
            : verifyCandidateSmoke(process.env)
        ).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            Context.get(services, HttpClient.HttpClient)
          ),
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" })
        );
      })
    )
  );
  const passed = Exit.isSuccess(result);
  const smokeEnvironment = process.env;
  const attestationFile = smokeEnvironment.SMOKE_ATTESTATION_FILE;
  if (passed && process.argv[2] !== "promoted" && attestationFile?.startsWith("/") === true) {
    await Bun.write(
      attestationFile,
      JSON.stringify({
        revision: smokeEnvironment.RELEASE_GIT_SHA,
        publicVersionId: smokeEnvironment.PUBLIC_VERSION_ID,
        coreVersionId: smokeEnvironment.CORE_VERSION_ID,
      })
    );
  }
  const error = Exit.isFailure(result) ? Cause.findErrorOption(result.cause) : Option.none();
  const safeReason =
    Option.isSome(error) &&
    (error.value instanceof ReleaseSmokeFailed || error.value instanceof CandidateRoutingPending)
      ? error.value.reason
      : "unclassified smoke failure (no provider response logged)";
  await Bun.write(
    passed ? Bun.stdout : Bun.stderr,
    passed ? "Production smoke passed.\n" : `Production smoke failed: ${safeReason}.\n`
  );
  if (!passed) process.exitCode = 1;
}
