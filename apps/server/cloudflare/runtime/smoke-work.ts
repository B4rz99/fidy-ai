import { verifyCategoryStorage } from "../categories/runtime";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Clock, Data, Effect, Option, Schema } from "effect";
import {
  type SmokeFailureStage,
  SmokeIdentity,
  type SmokeIdentity as SmokeIdentityType,
  SmokeRequest,
  type SmokeRequest as SmokeRequestType,
  smokeFailureHeader,
  smokeIdentityHeader,
  smokeManifest,
  smokeProofAccepted,
} from "./smoke";
import { cloudflareWorkerTelemetry, observeWorkerPromise, workerRelease } from "./telemetry";
import { RequestBodyPolicy, boundedJsonBody } from "../http/request-body";

const SmokeWork = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  probeId: SmokeRequest.fields.probeId,
  gitRevision: SmokeIdentity.fields.gitRevision,
});
type SmokeWork = typeof SmokeWork.Type;

type SmokeRow = { git_revision: string; expires_at_ms: number; status: string };
export type SmokeEnvironment = Readonly<{
  DB: D1Database;
  SMOKE_BUCKET: R2Bucket;
  SMOKE_QUEUE: Queue;
  SMOKE_WORKFLOW: Workflow;
  SMOKE_QUEUE_NAME: string;
  USER_TRANSACTION_COORDINATOR: { getByName: (name: string) => Pick<Fetcher, "fetch"> };
  SMOKE_PROOF: string;
  CF_VERSION_METADATA: { id: string };
  RELEASE_GIT_SHA: string;
  CONTRACT_DIGEST: string;
  KAPSO_API_KEY: string;
  KAPSO_WEBHOOK_SECRET: string;
  RESEND_API_KEY: string;
  WOMPI_PRIVATE_KEY: string;
  WOMPI_INTEGRITY_SECRET: string;
  WOMPI_EVENT_SECRET: string;
}>;

const fail = (stage: SmokeFailureStage = "platform"): Response =>
  Response.json(
    { status: "unavailable" },
    { status: 503, headers: { [smokeFailureHeader]: stage } }
  );
const refused = (): Response => Response.json({}, { status: 404 });
const markerKey = "_release-smoke/marker-v1";
const maxBodyBytes = 512;
const smokeWindowMs = 300_000;
export const maxActiveProbes = 8;
export const smokeAdmissionSql =
  "INSERT OR IGNORE INTO release_smoke_probes (probe_id, git_revision, expires_at_ms, status) SELECT ?, ?, ?, 'pending' WHERE (SELECT COUNT(*) FROM release_smoke_probes WHERE expires_at_ms > ?) < ?";
export const smokeClaimSql =
  "UPDATE release_smoke_probes SET status = 'queued' WHERE probe_id = ? AND status = 'pending' AND expires_at_ms > ?";
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

/** Convert only platform Promises; their causes never cross the public smoke response. */
class SmokeBindingFailed extends Data.TaggedError("SmokeBindingFailed")<{
  stage: SmokeFailureStage;
}> {}

const platform = <A>(
  tryWork: () => Promise<A>,
  stage: SmokeFailureStage = "platform"
): Effect.Effect<A, SmokeBindingFailed> =>
  Effect.tryPromise({ try: tryWork, catch: () => new SmokeBindingFailed({ stage }) });

/** Remove probe metadata strictly before the supplied Unix epoch millisecond decision instant. */
export const expireSmokeProbes = ({
  db,
  nowEpochMs,
}: Readonly<{ db: D1Database; nowEpochMs: number }>): Effect.Effect<void, void> =>
  platform(() =>
    db.prepare("DELETE FROM release_smoke_probes WHERE expires_at_ms < ?").bind(nowEpochMs).run()
  ).pipe(
    Effect.asVoid,
    Effect.mapError(() => undefined)
  );

const readProbe = Effect.fn(function* (environment: SmokeEnvironment, probeId: string) {
  const row = yield* platform(
    () =>
      environment.DB.prepare(
        "SELECT git_revision, expires_at_ms, status FROM release_smoke_probes WHERE probe_id = ?"
      )
        .bind(probeId)
        .first<SmokeRow>(),
    "probe_read"
  );
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
  yield* platform(
    () => environment.DB.prepare("SELECT probe_id FROM release_smoke_probes LIMIT 0").all(),
    "schema"
  );
  yield* platform(() => environment.SMOKE_BUCKET.put(markerKey, "smoke-v1"), "storage");
  if ((yield* platform(() => environment.SMOKE_BUCKET.get(markerKey), "storage")) === null) {
    return yield* new SmokeBindingFailed({ stage: "storage" });
  }
  const compatibility = yield* platform(
    () =>
      environment.USER_TRANSACTION_COORDINATOR.getByName("_release-smoke-v1").fetch(
        "https://coordinator.internal/release-smoke"
      ),
    "coordinator"
  );
  if (!compatibility.ok) return yield* new SmokeBindingFailed({ stage: "coordinator" });
});

const publishClaimedProbe = Effect.fn(function* (
  probeId: string,
  environment: SmokeEnvironment,
  now: number
) {
  const claimed = yield* platform(
    () => environment.DB.prepare(smokeClaimSql).bind(probeId, now).run(),
    "claim"
  );
  if (claimed.meta.changes !== 1) return;
  yield* checkBindings(environment);
  yield* platform(
    () =>
      environment.SMOKE_QUEUE.send({
        protocolVersion: 1,
        probeId,
        gitRevision: environment.RELEASE_GIT_SHA,
      } satisfies SmokeWork),
    "publication"
  );
});

const matchesCore = (probe: SmokeRequestType, environment: SmokeEnvironment): boolean =>
  probe.expectedCoreVersionId === environment.CF_VERSION_METADATA.id &&
  probe.expectedGitRevision === environment.RELEASE_GIT_SHA &&
  probe.expectedContractDigest === environment.CONTRACT_DIGEST;

const startProbe = Effect.fn(function* (request: Request, environment: SmokeEnvironment) {
  if (Number(request.headers.get("content-length")) > maxBodyBytes) return refused();
  const decoded = yield* platform(() =>
    boundedJsonBody({ request, policy: bodyPolicy, schema: SmokeRequest })
  );
  if (Option.isNone(decoded)) return refused();
  const probe = decoded.value;
  if (!matchesCore(probe, environment)) {
    const response = fail("identity");
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
  }
  const now = yield* Clock.currentTimeMillis;
  // One serialized statement caps concurrent distinct probes; replays are idempotent.
  yield* platform(
    () =>
      environment.DB.prepare(smokeAdmissionSql)
        .bind(probe.probeId, environment.RELEASE_GIT_SHA, now + smokeWindowMs, now, maxActiveProbes)
        .run(),
    "admission"
  );
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
  environment: SmokeEnvironment
) {
  const decoded = Schema.decodeUnknownOption(SmokeWork)(message.body);
  if (Option.isNone(decoded)) return yield* new SmokeBindingFailed({ stage: "platform" });
  const work = decoded.value;
  const row = yield* platform(() =>
    environment.DB.prepare(
      "SELECT expires_at_ms FROM release_smoke_probes WHERE probe_id = ? AND git_revision = ?"
    )
      .bind(work.probeId, work.gitRevision)
      .first<{ expires_at_ms: number }>()
  );
  const now = yield* Clock.currentTimeMillis;
  if (row === null || row.expires_at_ms <= now) {
    message.ack();
    return;
  }
  const id = `release-smoke-${work.probeId}`;
  yield* platform(() => environment.SMOKE_WORKFLOW.create({ id, params: work })).pipe(
    Effect.catch(() => platform(() => environment.SMOKE_WORKFLOW.get(id)))
  );
  message.ack();
});

/** Only the dedicated Queue may hand off synthetic work to this Workflow. */
export const receiveSmoke = ({
  batch,
  environment,
}: Readonly<{ batch: MessageBatch<unknown>; environment: SmokeEnvironment }>): Promise<void> =>
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

const settleSyntheticSmoke = (db: D1Database, work: SmokeWork): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* platform(() =>
        db
          .prepare(
            "UPDATE release_smoke_probes SET status = 'passed' WHERE probe_id = ? AND git_revision = ? AND expires_at_ms > ? AND status = 'queued'"
          )
          .bind(work.probeId, work.gitRevision, now)
          .run()
      );
    })
  );

/** Stable Workflow name and step: no provider call, model inference, or User-owned table. */
export class ReleaseSmokeWorkflowV1 extends WorkflowEntrypoint<SmokeEnvironment, unknown> {
  run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    const db = this.env.DB;
    const work = Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(SmokeWork)(event.payload);
      if (Option.isNone(decoded)) return yield* new SmokeBindingFailed({ stage: "platform" });
      yield* platform(() =>
        step.do("settle-synthetic-smoke-v1", () => settleSyntheticSmoke(db, decoded.value))
      );
    });
    return observeWorkerPromise(() => Effect.runPromise(work), {
      environment: workerRelease(this.env),
      telemetry: cloudflareWorkerTelemetry,
      operation: "workflow.releaseSmoke",
    });
  }
}
