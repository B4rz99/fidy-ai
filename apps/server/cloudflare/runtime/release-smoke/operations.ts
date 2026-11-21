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
  smokeProofAccepted,
} from "./contract";
import { initializeSharedStores } from "../../storage-bootstrap/operations";
import { releaseProbeName, storeTransactionUrl } from "../sqlite/contract";
import { Clock, Effect, Layer, ManagedRuntime, Option, Predicate, Result, Schema } from "effect";

import { RequestBodyPolicy } from "../../http/contract";
import { boundedJsonBody } from "../../http/operations";
import { SmokeWork, smokeExecutionId, smokeLifetimeMs, smokeMarkerKey } from "./internal/protocol";
import { SmokeBindingFailed, platform } from "./internal/platform";

const boundaryRuntime = ManagedRuntime.make(Layer.empty);

export const verifySmokeIdentity = ({
  expected,
  observed,
}: Readonly<{ expected: SmokeIdentityType; observed: SmokeIdentityType }>): boolean =>
  expected.gitRevision === observed.gitRevision &&
  expected.contractDigest === observed.contractDigest &&
  expected.workerVersionId === observed.workerVersionId;

const fail = (stage: SmokeFailureStage = "platform"): Response =>
  Response.json(
    { status: "unavailable" },
    { status: 503, headers: { [smokeFailureHeader]: stage } }
  );

const refused = (): Response => Response.json({}, { status: 404 });

const maxBodyBytes = 512;

const acceptedStatus = 202;

const completedStatus = 200;

const storeProofStatus = 204;

const bodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: maxBodyBytes,
  deadlineMilliseconds: 3000,
});

const releaseIdentity = (environment: SmokeEnvironment): SmokeIdentityType => ({
  gitRevision: environment.RELEASE_GIT_SHA,
  contractDigest: environment.CONTRACT_DIGEST,
  workerVersionId: environment.CF_VERSION_METADATA.id,
});

const retainedExecutor = {
  gitRevision: "de04a192c3836be0efb488b170a7b93b9f98f28f",
  workerVersionId: "54c5d73f-2682-4626-85bc-f8462914b1d4",
};

const usesRetainedExecutor = (environment: SmokeEnvironment): boolean =>
  environment.NATIVE_STORAGE_ADMISSION === "closed" &&
  environment.NATIVE_FIXTURE_MEMBER === "performance-2" &&
  environment.RELEASE_GIT_SHA !== retainedExecutor.gitRevision &&
  environment.SMOKE_QUEUE_NAME === "fidy-native-smoke-" + retainedExecutor.gitRevision;

const responseFor = (environment: SmokeEnvironment, status: string, httpStatus: number): Response =>
  Response.json(
    { status, core: releaseIdentity(environment), manifest: smokeManifest },
    { status: httpStatus }
  );

const checkBindings = Effect.fn(function* (environment: SmokeEnvironment, work: SmokeWork) {
  const secrets = [
    environment.SMOKE_PROOF,
    environment.KAPSO_API_KEY,
    environment.KAPSO_WEBHOOK_SECRET,
    environment.RESEND_API_KEY,
    environment.WOMPI_PRIVATE_KEY,
    environment.WOMPI_INTEGRITY_SECRET,
    environment.WOMPI_EVENT_SECRET,
  ];

  if (secrets.some((secret) => !Predicate.isString(secret) || secret.length === 0)) {
    return yield* new SmokeBindingFailed({ stage: "secrets" });
  }

  yield* initializeSharedStores(environment).pipe(
    Effect.tapError(Effect.logDebug),
    Effect.mapError(() => new SmokeBindingFailed({ stage: "schema" }))
  );
  const store = environment.USER_STORE;

  if (store === undefined) return yield* new SmokeBindingFailed({ stage: "schema" });

  const checked = yield* platform({
    stage: "schema",
    tryWork: () => store.getByName(releaseProbeName).fetch(storeTransactionUrl, { method: "POST" }),
  });

  if (checked.status !== storeProofStatus) {
    return yield* new SmokeBindingFailed({ stage: "schema" });
  }

  yield* platform({
    tryWork: () => environment.SMOKE_BUCKET.put(smokeMarkerKey(work), work.contractDigest),
    stage: "storage",
  });

  if (
    (yield* platform({
      tryWork: () =>
        environment.SMOKE_BUCKET.get(smokeMarkerKey(work)).then((value) => value?.text()),
      stage: "storage",
    })) !== work.contractDigest
  ) {
    return yield* new SmokeBindingFailed({ stage: "storage" });
  }
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

  const work: SmokeWork = {
    protocolVersion: 2,
    probeId: probe.probeId,
    gitRevision: usesRetainedExecutor(environment)
      ? retainedExecutor.gitRevision
      : environment.RELEASE_GIT_SHA,
    contractDigest: environment.CONTRACT_DIGEST,
    coreVersionId: environment.CF_VERSION_METADATA.id,
    expiresAtMs: now + smokeLifetimeMs,
  };

  yield* checkBindings(environment, work);

  if (probe.verifyBancolombiaSandbox === true) {
    yield* bankAuthentication.pipe(
      Effect.mapError((error) => new SmokeBindingFailed({ stage: error.stage }))
    );
  }

  yield* platform({ stage: "publication", tryWork: () => environment.SMOKE_QUEUE.send(work) });

  return responseFor(environment, "pending", acceptedStatus);
});

const matchesExecutor = (
  observed: SmokeIdentityType,
  expected: SmokeIdentityType,
  retained: boolean
): boolean =>
  retained
    ? verifySmokeIdentity({
        expected: { ...retainedExecutor, contractDigest: expected.contractDigest },
        observed,
      })
    : observed.gitRevision === expected.gitRevision &&
      observed.contractDigest === expected.contractDigest;

const validCompletion = ({
  output,
  probeId,
  expected,
  retained,
  now,
}: Readonly<{
  output: unknown;
  probeId: string;
  expected: SmokeIdentityType;
  retained: boolean;
  now: number;
}>): boolean => {
  const decoded = Schema.decodeUnknownOption(SmokeCompletion)(output);

  return (
    Option.isSome(decoded) &&
    decoded.value.probeId === probeId &&
    decoded.value.expiresAtMs > now &&
    decoded.value.expiresAtMs <= now + smokeLifetimeMs &&
    decoded.value.coreVersionId === expected.workerVersionId &&
    matchesExecutor(decoded.value.executor, expected, retained)
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

  if (Result.isFailure(lookup)) return responseFor(environment, "pending", completedStatus);
  const state = lookup.success;

  if (state.status === "errored" || state.status === "terminated") return fail("probe_state");

  if (state.status !== "complete") return responseFor(environment, "pending", completedStatus);

  if (
    !validCompletion({
      output: state.output,
      probeId: probeId.value,
      expected: releaseIdentity(environment),
      retained: usesRetainedExecutor(environment),
      now,
    })
  ) {
    return fail("probe_state");
  }

  return responseFor(environment, "passed", completedStatus);
});

export const handleSmoke = ({
  request,
  environment,
  bankAuthentication,
}: Readonly<{
  request: Request;
  environment: SmokeEnvironment;
  bankAuthentication: Option.Option<Effect.Effect<void, BancolombiaAuthenticationFailed>>;
}>): Promise<Response> =>
  boundaryRuntime.runPromise(
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

export const receiveSmoke = ({
  batch,
  environment,
}: Readonly<{ batch: MessageBatch<unknown>; environment: SmokeQueueEnvironment }>): Promise<void> =>
  boundaryRuntime.runPromise(
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

export const smokeReady = (environment: Partial<SmokeBindings>): environment is SmokeBindings =>
  environment.SMOKE_LIMITER !== undefined &&
  environment.SMOKE_BUCKET !== undefined &&
  environment.SMOKE_QUEUE !== undefined &&
  environment.SMOKE_WORKFLOW !== undefined &&
  environment.SMOKE_QUEUE_NAME !== undefined &&
  environment.SMOKE_PROOF !== undefined &&
  environment.CF_VERSION_METADATA !== undefined;
