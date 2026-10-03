import {
  type SmokeBindings,
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
import { Clock, Effect, Option, Schema } from "effect";

import { RequestBodyPolicy } from "../../http/contract";
import { boundedJsonBody } from "../../http/operations";
import { SmokeWork } from "./internal/protocol";
import { SmokeBindingFailed, platform } from "./internal/platform";
import { maxActiveProbes, smokeAdmissionSql, smokeClaimSql } from "./internal/admission";

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

type SmokeRow = { git_revision: string; expires_at_ms: number; status: string };

const fail = (stage: SmokeFailureStage = "platform"): Response =>
  Response.json(
    { status: "unavailable" },
    { status: 503, headers: { [smokeFailureHeader]: stage } }
  );
const refused = (): Response => Response.json({}, { status: 404 });
const markerKey = "_release-smoke/marker-v1";
const maxBodyBytes = 512;
const smokeWindowMs = 300_000;
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

/** Remove probe metadata strictly before the supplied Unix epoch millisecond decision instant. */
export const expireSmokeProbes = ({
  db,
  nowEpochMs,
}: Readonly<{ db: D1Database; nowEpochMs: number }>): Effect.Effect<void, void> =>
  platform({
    stage: "platform",
    tryWork: () =>
      db.prepare("DELETE FROM release_smoke_probes WHERE expires_at_ms < ?").bind(nowEpochMs).run(),
  }).pipe(
    Effect.asVoid,
    Effect.mapError(() => undefined)
  );

const readProbe = Effect.fn(function* (environment: SmokeEnvironment, probeId: string) {
  const row = yield* platform({
    tryWork: () =>
      environment.DB.prepare(
        "SELECT git_revision, expires_at_ms, status FROM release_smoke_probes WHERE probe_id = ?"
      )
        .bind(probeId)
        .first<SmokeRow>(),
    stage: "probe_read",
  });
  return Option.fromNullishOr(row);
});

const validRow = (
  row: Option.Option<SmokeRow>,
  environment: SmokeEnvironment,
  now: number
): row is Option.Some<SmokeRow> =>
  Option.isSome(row) &&
  row.value.git_revision === environment.RELEASE_GIT_SHA &&
  row.value.expires_at_ms > now &&
  (row.value.status === "pending" ||
    row.value.status === "queued" ||
    row.value.status === "passed");

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
  // The owner verifies its schema without loading Category or User content.
  yield* verifyCategoryStorage({ db: environment.DB }).pipe(
    Effect.mapError(() => new SmokeBindingFailed({ stage: "schema" }))
  );
  yield* platform({
    tryWork: () =>
      environment.DB.prepare("SELECT probe_id FROM release_smoke_probes LIMIT 0").all(),
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

const publishClaimedProbe = Effect.fn(function* (
  probeId: string,
  environment: SmokeEnvironment,
  now: number
) {
  const claimed = yield* platform({
    tryWork: () => environment.DB.prepare(smokeClaimSql).bind(probeId, now).run(),
    stage: "claim",
  });
  if (claimed.meta.changes !== 1) return;
  yield* checkBindings(environment);
  yield* platform({
    tryWork: () =>
      environment.SMOKE_QUEUE.send({
        protocolVersion: 1,
        probeId,
        gitRevision: environment.RELEASE_GIT_SHA,
      } satisfies SmokeWork),
    stage: "publication",
  });
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

const startProbe = Effect.fn(function* (request: Request, environment: SmokeEnvironment) {
  if (Number(request.headers.get("content-length")) > maxBodyBytes) return refused();
  const decoded = yield* platform({
    stage: "platform",
    tryWork: () => boundedJsonBody({ request, policy: bodyPolicy, schema: SmokeRequest }),
  });
  if (Option.isNone(decoded)) return refused();
  const probe = decoded.value;
  if (probe.expectedGitRevision === smokeDiagnosticRevision || !matchesCore(probe, environment)) {
    return identityFailure(probe, environment);
  }
  const now = yield* Clock.currentTimeMillis;
  // One serialized statement caps concurrent distinct probes; replays are idempotent.
  yield* platform({
    tryWork: () =>
      environment.DB.prepare(smokeAdmissionSql)
        .bind(probe.probeId, environment.RELEASE_GIT_SHA, now + smokeWindowMs, now, maxActiveProbes)
        .run(),
    stage: "admission",
  });
  const row = yield* readProbe(environment, probe.probeId);
  if (!validRow(row, environment, now)) return fail("probe_state");
  // Atomic claim prevents replays from repeating binding checks or Queue publication.
  if (row.value.status === "pending") yield* publishClaimedProbe(probe.probeId, environment, now);
  return responseFor(
    environment,
    row.value.status === "passed" ? "passed" : "pending",
    acceptedStatus
  );
});

const getProbe = Effect.fn(function* (request: Request, environment: SmokeEnvironment) {
  const parameters = new URL(request.url).searchParams;
  // Identity-only readiness precedes synthetic work; no schema, admission, or binding effects.
  if (parameters.get("readiness") === "1") {
    return responseFor(environment, "pending", completedStatus);
  }
  const probeId = parameters.get("probeId");
  if (probeId === null || !Schema.is(SmokeWork.fields.probeId)(probeId)) return refused();
  const row = yield* readProbe(environment, probeId);
  const now = yield* Clock.currentTimeMillis;
  return validRow(row, environment, now)
    ? responseFor(
        environment,
        row.value.status === "passed" ? "passed" : "pending",
        completedStatus
      )
    : fail("probe_state");
});

/** Private, reserved-only protocol: it never receives a User identity or arbitrary resource key. */
export const handleSmoke = ({
  request,
  environment,
}: Readonly<{ request: Request; environment: SmokeEnvironment }>): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (!smokeProofAccepted({ request, secret: environment.SMOKE_PROOF })) return refused();
      if (request.method === "POST") return yield* startProbe(request, environment);
      if (request.method === "GET") return yield* getProbe(request, environment);
      return refused();
    }).pipe(
      Effect.catch((error) => Effect.succeed(fail(error.stage))),
      Effect.catchCause(() => Effect.succeed(fail("platform")))
    )
  );

const receiveMessage = Effect.fn(function* (
  message: Message<unknown>,
  environment: SmokeQueueEnvironment
) {
  const decoded = Schema.decodeUnknownOption(SmokeWork)(message.body);
  if (Option.isNone(decoded)) return yield* new SmokeBindingFailed({ stage: "platform" });
  const work = decoded.value;
  const row = yield* platform({
    stage: "platform",
    tryWork: () =>
      environment.DB.prepare(
        "SELECT expires_at_ms FROM release_smoke_probes WHERE probe_id = ? AND git_revision = ?"
      )
        .bind(work.probeId, work.gitRevision)
        .first<{ expires_at_ms: number }>(),
  });
  const now = yield* Clock.currentTimeMillis;
  if (row === null || row.expires_at_ms <= now) {
    message.ack();
    return;
  }
  const id = `release-smoke-${work.probeId}`;
  yield* platform({
    stage: "platform",
    tryWork: () => environment.SMOKE_WORKFLOW.create({ id, params: work }),
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
        concurrency: "unbounded",
      });
    })
  );

/** Preserve the native smoke binding readiness gate before exercising synthetic work. */
export const smokeReady = (environment: Partial<SmokeBindings>): environment is SmokeBindings =>
  environment.SMOKE_BUCKET !== undefined &&
  environment.SMOKE_QUEUE !== undefined &&
  environment.SMOKE_WORKFLOW !== undefined &&
  environment.SMOKE_QUEUE_NAME !== undefined &&
  environment.SMOKE_PROOF !== undefined &&
  environment.CF_VERSION_METADATA !== undefined;
