import { BancolombiaAuthenticationFailed } from "../../bancolombia-authentication/contract";
import {
  type SmokeBindings,
  SmokeCompletion,
  type SmokeEnvironment,
  type SmokeFailureStage,
  SmokeIdentity,
  type SmokeIdentity as SmokeIdentityType,
  type SmokeQueueEnvironment,
  SmokeRequest,
  type SmokeRequest as SmokeRequestType,
  smokeCoreVersionHeader,
  smokeDiagnosticRevision,
  smokeFailureHeader,
  smokeIdentityHeader,
  smokeManifest,
  smokeProofHeader,
} from "./contract";
import { verifyCategoryStorage } from "../../categories/operations";
import { activeProUserCondition } from "../../../src/shell/access-tier/operations";
import { Clock, Effect, Option, Schema } from "effect";

import { RequestBodyPolicy } from "../../http/contract";
import { boundedJsonBody } from "../../http/operations";
import { SmokeWork, smokeExecutionId, smokeLifetimeMs } from "./internal/protocol";
import { verifySmokeDatabase } from "./internal/database";
import { SmokeBindingFailed, platform } from "./internal/platform";

/** The runner must compare observed Worker identities with its upload receipts, never trust a 2xx alone. */
export const verifySmokeIdentity = ({
  expected,
  observed,
}: Readonly<{ expected: SmokeIdentityType; observed: SmokeIdentityType }>): boolean =>
  expected.gitRevision === observed.gitRevision &&
  expected.contractDigest === observed.contractDigest &&
  expected.workerVersionId === observed.workerVersionId;

const smokeSecretPattern = /^[0-9a-f]{64}$/u;

/** A separate, randomly provisioned deployment-runner credential, never a User or provider grant. */
export const smokeProofAccepted = ({
  request,
  secret,
}: Readonly<{ request: Request; secret: string }>): boolean => {
  const offered = request.headers.get(smokeProofHeader) ?? "";
  if (!smokeSecretPattern.test(secret) || !smokeSecretPattern.test(offered)) return false;
  let difference = 0;
  for (let index = 0; index < secret.length; index++) {
    difference |= secret.charCodeAt(index) ^ offered.charCodeAt(index);
  }
  return difference === 0;
};

const fail = (stage: SmokeFailureStage = "platform"): Response =>
  Response.json(
    { status: "unavailable" },
    { status: 503, headers: { [smokeFailureHeader]: stage } }
  );
const refused = (): Response => Response.json({}, { status: 404 });
const markerKey = "_release-smoke/marker-v1";
const maxBodyBytes = 512;
const acceptedStatus = 202;
const completedStatus = 200;
const bodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: maxBodyBytes,
  deadlineMilliseconds: 3000,
});

const releaseIdentity = (environment: SmokeEnvironment): SmokeIdentityType => ({
  gitRevision: environment.RELEASE_GIT_SHA,
  contractDigest: environment.CONTRACT_DIGEST,
  workerVersionId: environment.CF_VERSION_METADATA.id,
});

const responseFor = (environment: SmokeEnvironment, status: string, httpStatus: number): Response =>
  Response.json(
    { status, core: releaseIdentity(environment), manifest: smokeManifest },
    { status: httpStatus }
  );

const checkBindings = Effect.fn(function* (environment: SmokeEnvironment) {
  const secrets = [
    environment.SMOKE_PROOF,
    environment.KAPSO_API_KEY,
    environment.KAPSO_WEBHOOK_SECRET,
    environment.RESEND_API_KEY,
    environment.WOMPI_PRIVATE_KEY,
    environment.WOMPI_INTEGRITY_SECRET,
    environment.WOMPI_EVENT_SECRET,
  ];
  if (secrets.some((secret) => typeof secret !== "string" || secret.length === 0)) {
    return yield* new SmokeBindingFailed({ stage: "secrets" });
  }
  yield* verifySmokeDatabase(environment.DB);
  yield* verifyCategoryStorage({ db: environment.DB }).pipe(
    Effect.mapError(() => new SmokeBindingFailed({ stage: "schema" }))
  );
  // Prepare the same standing dependency every protected canonical read uses. No User is
  // looked up or created: LIMIT 0 validates the deployed schema without producing a row.
  const standing = activeProUserCondition({
    userId: "00000000-0000-4000-8000-000000000000",
    nowEpochMs: 0,
  });
  yield* platform({
    tryWork: () =>
      environment.DB.prepare(`SELECT ${standing.sql} AS active LIMIT 0`)
        .bind(...standing.params)
        .all(),
    stage: "schema",
  });
  yield* platform({
    tryWork: () => environment.SMOKE_BUCKET.put(markerKey, "smoke-v1"),
    stage: "storage",
  });
  if (
    (yield* platform({
      tryWork: () => environment.SMOKE_BUCKET.get(markerKey),
      stage: "storage",
    })) === null
  ) {
    return yield* new SmokeBindingFailed({ stage: "storage" });
  }
  const compatibility = yield* platform({
    tryWork: () =>
      environment.USER_TRANSACTION_COORDINATOR.getByName("_release-smoke-v1").fetch(
        "https://coordinator.internal/release-smoke"
      ),
    stage: "coordinator",
  });
  if (!compatibility.ok) return yield* new SmokeBindingFailed({ stage: "coordinator" });
});

const matchesCore = (probe: SmokeRequestType, environment: SmokeEnvironment): boolean =>
  probe.expectedCoreVersionId === environment.CF_VERSION_METADATA.id &&
  probe.expectedGitRevision === environment.RELEASE_GIT_SHA &&
  probe.expectedContractDigest === environment.CONTRACT_DIGEST;

const identityFailure = (probe: SmokeRequestType, environment: SmokeEnvironment): Response => {
  const response = fail("identity");
  const version = Schema.decodeOption(SmokeIdentity.fields.workerVersionId)(
    environment.CF_VERSION_METADATA.id
  );
  if (Option.isSome(version)) response.headers.set(smokeCoreVersionHeader, version.value);
  response.headers.set(
    smokeIdentityHeader,
    [
      probe.expectedCoreVersionId === environment.CF_VERSION_METADATA.id,
      probe.expectedGitRevision === environment.RELEASE_GIT_SHA,
      probe.expectedContractDigest === environment.CONTRACT_DIGEST,
    ]
      .map((equal) => (equal ? "1" : "0"))
      .join("")
  );
  return response;
};

const startProbe = Effect.fn(function* (
  request: Request,
  environment: SmokeEnvironment,
  bankAuthentication: Effect.Effect<void, BancolombiaAuthenticationFailed>
) {
  if (Number(request.headers.get("content-length")) > maxBodyBytes) return refused();
  const decoded = yield* boundedJsonBody({ request, policy: bodyPolicy, schema: SmokeRequest });
  if (Option.isNone(decoded)) return refused();
  const probe = decoded.value;
  if (probe.expectedGitRevision === smokeDiagnosticRevision || !matchesCore(probe, environment)) {
    return identityFailure(probe, environment);
  }
  const admitted = yield* platform({
    stage: "admission",
    tryWork: () => environment.SMOKE_LIMITER.limit({ key: "release-smoke" }),
  });
  if (!admitted.success) return fail("admission");
  const now = yield* Clock.currentTimeMillis;
  yield* checkBindings(environment);
  if (probe.verifyBancolombiaSandbox === true) {
    yield* bankAuthentication.pipe(
      Effect.mapError((error) => new SmokeBindingFailed({ stage: error.stage }))
    );
  }
  const work: SmokeWork = {
    protocolVersion: 2,
    probeId: probe.probeId,
    gitRevision: environment.RELEASE_GIT_SHA,
    contractDigest: environment.CONTRACT_DIGEST,
    coreVersionId: environment.CF_VERSION_METADATA.id,
    expiresAtMs: now + smokeLifetimeMs,
  };
  yield* platform({ stage: "publication", tryWork: () => environment.SMOKE_QUEUE.send(work) });
  return responseFor(environment, "pending", acceptedStatus);
});

const validCompletion = ({
  output,
  probeId,
  expected,
  now,
}: Readonly<{
  output: unknown;
  probeId: string;
  expected: SmokeIdentityType;
  now: number;
}>): boolean => {
  const decoded = Schema.decodeUnknownOption(SmokeCompletion)(output);
  return (
    Option.isSome(decoded) &&
    decoded.value.probeId === probeId &&
    decoded.value.expiresAtMs > now &&
    decoded.value.expiresAtMs <= now + smokeLifetimeMs &&
    decoded.value.coreVersionId === expected.workerVersionId &&
    decoded.value.executor.gitRevision === expected.gitRevision &&
    decoded.value.executor.contractDigest === expected.contractDigest
  );
};

const getProbe = Effect.fn(function* (request: Request, environment: SmokeEnvironment) {
  const parameters = new URL(request.url).searchParams;
  if (parameters.get("readiness") === "1") {
    return responseFor(environment, "pending", completedStatus);
  }
  const probeId = Schema.decodeUnknownOption(SmokeWork.fields.probeId)(parameters.get("probeId"));
  if (Option.isNone(probeId)) return refused();
  const now = yield* Clock.currentTimeMillis;
  const lookup = yield* platform({
    stage: "probe_read",
    tryWork: () =>
      environment.SMOKE_WORKFLOW.get(
        smokeExecutionId({
          probeId: probeId.value,
          coreVersionId: environment.CF_VERSION_METADATA.id,
        })
      ).then((instance) => instance.status()),
  }).pipe(Effect.result);
  // Absent or unreadable execution can never pass; the independent CI poll budget expires.
  if (lookup._tag === "Failure") return responseFor(environment, "pending", completedStatus);
  const state = lookup.success;
  if (state.status === "errored" || state.status === "terminated") return fail("probe_state");
  if (state.status !== "complete") return responseFor(environment, "pending", completedStatus);
  if (
    !validCompletion({
      output: state.output,
      probeId: probeId.value,
      expected: releaseIdentity(environment),
      now,
    })
  ) {
    return fail("probe_state");
  }
  return responseFor(environment, "passed", completedStatus);
});

/** Private, reserved-only protocol: it never receives a User identity or arbitrary resource key. */
export const handleSmoke = ({
  request,
  environment,
  bankAuthentication,
}: Readonly<{
  request: Request;
  environment: SmokeEnvironment;
  bankAuthentication: Option.Option<Effect.Effect<void, BancolombiaAuthenticationFailed>>;
}>): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (!smokeProofAccepted({ request, secret: environment.SMOKE_PROOF })) return refused();
      if (request.method === "POST") {
        return yield* startProbe(
          request,
          environment,
          Option.getOrElse(bankAuthentication, () =>
            Effect.fail(new BancolombiaAuthenticationFailed({ stage: "bancolombia_configuration" }))
          )
        );
      }
      if (request.method === "GET") return yield* getProbe(request, environment);
      return refused();
    }).pipe(
      Effect.catch((error) => Effect.succeed(fail(error.stage))),
      Effect.catchCause(() => Effect.succeed(fail("platform")))
    ),
    { signal: request.signal }
  );

const receiveMessage = Effect.fn(function* (
  message: Message<unknown>,
  environment: SmokeQueueEnvironment
) {
  const decoded = Schema.decodeUnknownOption(SmokeWork)(message.body);
  if (Option.isNone(decoded)) return yield* new SmokeBindingFailed({ stage: "platform" });
  const work = decoded.value;
  const now = yield* Clock.currentTimeMillis;
  if (work.expiresAtMs <= now || work.expiresAtMs > now + smokeLifetimeMs) {
    message.ack();
    return;
  }
  const id = smokeExecutionId(work);
  yield* platform({
    stage: "platform",
    tryWork: () =>
      environment.SMOKE_WORKFLOW.create({
        id,
        params: work,
        retention: { successRetention: "1 day", errorRetention: "1 day" },
      }),
  }).pipe(
    Effect.catch(() =>
      platform({ stage: "platform", tryWork: () => environment.SMOKE_WORKFLOW.get(id) })
    )
  );
  message.ack();
});

/** Only the dedicated Queue may hand off synthetic work to this Workflow. */
export const receiveSmoke = ({
  batch,
  environment,
}: Readonly<{ batch: MessageBatch<unknown>; environment: SmokeQueueEnvironment }>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (batch.queue !== environment.SMOKE_QUEUE_NAME) {
        return yield* new SmokeBindingFailed({ stage: "platform" });
      }
      yield* Effect.forEach(batch.messages, (message) => receiveMessage(message, environment), {
        discard: true,
        concurrency: 4,
      });
    })
  );

/** Preserve the native smoke binding readiness gate before exercising synthetic work. */
export const smokeReady = (environment: Partial<SmokeBindings>): environment is SmokeBindings =>
  environment.SMOKE_LIMITER !== undefined &&
  environment.SMOKE_BUCKET !== undefined &&
  environment.SMOKE_QUEUE !== undefined &&
  environment.SMOKE_WORKFLOW !== undefined &&
  environment.SMOKE_QUEUE_NAME !== undefined &&
  environment.SMOKE_PROOF !== undefined &&
  environment.CF_VERSION_METADATA !== undefined;
