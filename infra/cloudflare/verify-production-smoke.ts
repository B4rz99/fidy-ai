/// <reference types="bun-types" />

import {
  Cause,
  Context,
  Data,
  Effect,
  Encoding,
  Exit,
  Layer,
  Option,
  Schedule,
  Schema,
} from "effect";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/unstable/http";
import {
  SmokeIdentity,
  SmokeResponse,
  smokePath,
  verifySmokeIdentity,
} from "../../apps/server/cloudflare/runtime/smoke";
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
class ReleaseSmokeFailed extends Data.TaggedError("ReleaseSmokeFailed")<{
  readonly reason: string;
}> {}

class CandidateRoutingPending extends Data.TaggedError("CandidateRoutingPending")<{
  readonly reason: string;
}> {}

const apiOrigin = "https://api.fidyapp.com";
const maxAttempts = 20;
const pollDelayMs = 1500;
const successStart = 200;
const successEnd = 300;
const probeEntropyBytes = 16;

const candidateHeaders = (
  config: RunnerConfig,
  publicVersionId: string
): Readonly<Record<string, string>> => ({
  "cloudflare-workers-version-overrides": `${config.PUBLIC_WORKER_NAME}="${publicVersionId}", ${config.CORE_WORKER_NAME}="${config.CORE_VERSION_ID}"`,
  "x-fidy-smoke-proof": config.SMOKE_PROOF,
});

const call = Effect.fn(function* (
  path: string,
  headers: Readonly<Record<string, string>>,
  body: Option.Option<string>
) {
  const client = yield* HttpClient.HttpClient;
  const url = `${apiOrigin}${path}`;
  const request = Option.isSome(body)
    ? HttpClientRequest.post(url, {
        headers: { ...headers, "content-type": "application/json" },
        body: HttpBody.text(body.value, "application/json"),
      })
    : HttpClientRequest.get(url, { headers });
  return yield* client.execute(request).pipe(Effect.timeout("8 seconds"));
});

const candidateResponseDiagnostic = (
  response: HttpClientResponse.HttpClientResponse,
  expectedPublic: SmokeIdentity
): string => {
  const observedVersion = response.headers["x-fidy-smoke-worker-version"];
  let versionState = "other";
  if (observedVersion === undefined) versionState = "missing";
  else if (observedVersion === expectedPublic.workerVersionId) versionState = "expected";
  return `Candidate request did not reach the expected public Worker (status=${response.status}, version=${versionState}, noStore=${response.headers["cache-control"] === "no-store"})`;
};

const isRoutingFallback = (
  response: HttpClientResponse.HttpClientResponse,
  expectedPublic: SmokeIdentity
): boolean =>
  response.status >= successStart &&
  response.status < successEnd &&
  response.headers["cache-control"] === "no-store" &&
  Schema.is(SmokeIdentity.fields.workerVersionId)(
    response.headers["x-fidy-smoke-worker-version"]
  ) &&
  response.headers["x-fidy-smoke-worker-version"] !== expectedPublic.workerVersionId;

const checkPublicResponse = Effect.fn(function* (
  response: HttpClientResponse.HttpClientResponse,
  expectedPublic: SmokeIdentity
) {
  if (isRoutingFallback(response, expectedPublic)) {
    return yield* new CandidateRoutingPending({
      reason: candidateResponseDiagnostic(response, expectedPublic),
    });
  }
  if (
    response.status < successStart ||
    response.status >= successEnd ||
    response.headers["cache-control"] !== "no-store" ||
    response.headers["x-fidy-smoke-worker-version"] !== expectedPublic.workerVersionId
  ) {
    return yield* new ReleaseSmokeFailed({
      reason: candidateResponseDiagnostic(response, expectedPublic),
    });
  }
});

const check = Effect.fn(function* (
  response: HttpClientResponse.HttpClientResponse,
  config: RunnerConfig,
  expectedPublic: SmokeIdentity
) {
  yield* checkPublicResponse(response, expectedPublic);
  const raw = yield* response.json;
  const result = Schema.decodeUnknownOption(
    Schema.Struct({ ...SmokeResponse.fields, public: SmokeIdentity })
  )(raw);
  const expected = { gitRevision: config.RELEASE_GIT_SHA, contractDigest: config.CONTRACT_DIGEST };
  if (
    Option.isNone(result) ||
    !verifySmokeIdentity({
      expected: expectedPublic,
      observed: result.value.public,
    }) ||
    !verifySmokeIdentity({
      expected: { ...expected, workerVersionId: config.CORE_VERSION_ID },
      observed: result.value.core,
    })
  ) {
    return yield* new ReleaseSmokeFailed({
      reason: "Candidate smoke did not prove the compatible public and Core release",
    });
  }
  return result.value.status;
});

const awaitSyntheticWork = Effect.fn(function* (
  config: RunnerConfig,
  headers: Readonly<Record<string, string>>,
  expectedPublic: SmokeIdentity
) {
  const probeId = Encoding.encodeHex(crypto.getRandomValues(new Uint8Array(probeEntropyBytes)));
  const request = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    protocolVersion: 1,
    probeId,
    expectedPublicVersionId: expectedPublic.workerVersionId,
    expectedCoreVersionId: config.CORE_VERSION_ID,
    expectedGitRevision: config.RELEASE_GIT_SHA,
    expectedContractDigest: config.CONTRACT_DIGEST,
  });
  // Cloudflare may briefly ignore an override after staging. Replay this single,
  // idempotent probe only for a valid public-version fallback, never transport or authority errors.
  let status = yield* Effect.gen(function* () {
    return yield* check(
      yield* call(smokePath, headers, Option.some(request)),
      config,
      expectedPublic
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
    status = yield* check(
      yield* call(`${smokePath}?probeId=${probeId}`, headers, Option.none()),
      config,
      expectedPublic
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
        const response = yield* call(
          path,
          { ...headers, ...probeHeaders },
          method === "POST" ? Option.some("{}") : Option.none()
        );
        return { status: response.status, headers: new Headers(response.headers) };
      }),
    candidate: Option.some({
      proof: config.SMOKE_PROOF,
      override: headers["cloudflare-workers-version-overrides"] ?? "",
      publicVersionId: config.PUBLIC_VERSION_ID,
    }),
  }).pipe(Effect.exit);
  if (Exit.isFailure(result)) {
    return yield* new ReleaseSmokeFailed({
      reason: "Candidate edge rejections or headers were not verified",
    });
  }
});

/** Explicitly pinned HTTP invocations; a fallback to stable always fails identity comparison. */
export const verifyProductionSmoke = Effect.fn(function* (env: unknown) {
  const decoded = Schema.decodeUnknownOption(RunnerConfig)(env);
  if (Option.isNone(decoded)) {
    return yield* new ReleaseSmokeFailed({ reason: "Incomplete production smoke configuration" });
  }
  const config = decoded.value;
  const headers = candidateHeaders(config, config.PUBLIC_VERSION_ID);
  yield* awaitSyntheticWork(config, headers, {
    gitRevision: config.RELEASE_GIT_SHA,
    contractDigest: config.CONTRACT_DIGEST,
    workerVersionId: config.PUBLIC_VERSION_ID,
  });
  yield* checkEdge(config, headers);
  // The next promotion changes Core first. This exact old-public/new-Core pairing must work
  // before normal traffic can see it; a healthy new/new pair is not sufficient evidence.
  yield* awaitSyntheticWork(config, candidateHeaders(config, config.STABLE_PUBLIC_VERSION_ID), {
    gitRevision: config.STABLE_RELEASE_GIT_SHA,
    contractDigest: config.STABLE_CONTRACT_DIGEST,
    workerVersionId: config.STABLE_PUBLIC_VERSION_ID,
  });
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
  yield* awaitSyntheticWork(
    config,
    { "x-fidy-smoke-proof": config.SMOKE_PROOF },
    {
      gitRevision: config.RELEASE_GIT_SHA,
      contractDigest: config.CONTRACT_DIGEST,
      workerVersionId: config.PUBLIC_VERSION_ID,
    }
  );
});

if (import.meta.main) {
  const result = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Layer.build(FetchHttpClient.layer);
        return yield* (
          process.argv[2] === "promoted"
            ? verifyPromotedSmoke(process.env)
            : verifyProductionSmoke(process.env)
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
