import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Option, Schema } from "effect";
import {
  SmokeIdentity,
  type SmokeIdentity as SmokeIdentityType,
  SmokeRequest,
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

const fail = (): Response => Response.json({ status: "unavailable" }, { status: 503 });
const refused = (): Response => Response.json({}, { status: 404 });
const markerKey = "_release-smoke/marker-v1";
const maxBodyBytes = 512;
const smokeWindowMs = 300_000;
const maxActiveProbes = 8;
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

const readProbe = async (
  environment: SmokeEnvironment,
  probeId: string
): Promise<Option.Option<SmokeRow>> =>
  Option.fromNullishOr(
    await environment.DB.prepare(
      "SELECT git_revision, expires_at_ms, status FROM release_smoke_probes WHERE probe_id = ?"
    )
      .bind(probeId)
      .first<SmokeRow>()
  );

const validRow = (
  row: Option.Option<SmokeRow>,
  environment: SmokeEnvironment
): row is Option.Some<SmokeRow> =>
  Option.isSome(row) &&
  row.value.git_revision === environment.RELEASE_GIT_SHA &&
  row.value.expires_at_ms > Date.now() &&
  (row.value.status === "pending" ||
    row.value.status === "queued" ||
    row.value.status === "passed");

const checkBindings = async (environment: SmokeEnvironment): Promise<boolean> => {
  const secrets = [
    environment.SMOKE_PROOF,
    environment.KAPSO_API_KEY,
    environment.KAPSO_WEBHOOK_SECRET,
    environment.RESEND_API_KEY,
    environment.WOMPI_PRIVATE_KEY,
    environment.WOMPI_INTEGRITY_SECRET,
    environment.WOMPI_EVENT_SECRET,
  ];
  if (secrets.some((secret) => typeof secret !== "string" || secret.length === 0)) return false;
  // Zero rows: verify the schema without loading any Category or User content.
  await environment.DB.prepare("SELECT id FROM categories LIMIT 0").all();
  await environment.DB.prepare("SELECT probe_id FROM release_smoke_probes LIMIT 0").all();
  await environment.SMOKE_BUCKET.put(markerKey, "smoke-v1");
  if ((await environment.SMOKE_BUCKET.get(markerKey)) === null) return false;
  const coordinator = environment.USER_TRANSACTION_COORDINATOR.getByName("_release-smoke-v1");
  const compatibility = await coordinator.fetch("https://coordinator.internal/release-smoke");
  return compatibility.ok;
};

// oxlint-disable-next-line eslint/complexity -- Each refusal avoids admitting synthetic work.
const startProbe = async (request: Request, environment: SmokeEnvironment): Promise<Response> => {
  if (Number(request.headers.get("content-length")) > maxBodyBytes) return refused();
  const decoded = await boundedJsonBody({ request, policy: bodyPolicy, schema: SmokeRequest });
  if (Option.isNone(decoded)) return refused();
  const probe = decoded.value;
  if (
    probe.expectedCoreVersionId !== environment.CF_VERSION_METADATA.id ||
    probe.expectedGitRevision !== environment.RELEASE_GIT_SHA ||
    probe.expectedContractDigest !== environment.CONTRACT_DIGEST
  ) {
    return fail();
  }
  // SQLite serializes this single admission statement: even concurrent distinct IDs cannot
  // create unbounded synthetic Work. Replays of an admitted probe remain idempotent.
  await environment.DB.prepare(
    "INSERT OR IGNORE INTO release_smoke_probes (probe_id, git_revision, expires_at_ms, status) SELECT ?, ?, ?, 'pending' WHERE (SELECT COUNT(*) FROM release_smoke_probes WHERE expires_at_ms > ?) < ?"
  )
    .bind(
      probe.probeId,
      environment.RELEASE_GIT_SHA,
      Date.now() + smokeWindowMs,
      Date.now(),
      maxActiveProbes
    )
    .run();
  const row = await readProbe(environment, probe.probeId);
  if (!validRow(row, environment)) return fail();
  if (row.value.status === "pending") {
    // The claim is atomic. A replay of the same pending ID cannot repeat binding checks or
    // publish unbounded Queue messages; a failed claim or Queue send fails closed for this ID.
    const claimed = await environment.DB.prepare(
      "UPDATE release_smoke_probes SET status = 'queued' WHERE probe_id = ? AND status = 'pending' AND expires_at_ms > ?"
    )
      .bind(probe.probeId, Date.now())
      .run();
    if (claimed.meta.changes === 1) {
      if (!(await checkBindings(environment))) return fail();
      await environment.SMOKE_QUEUE.send({
        protocolVersion: 1,
        probeId: probe.probeId,
        gitRevision: environment.RELEASE_GIT_SHA,
      } satisfies SmokeWork);
    }
  }
  return responseFor(
    environment,
    row.value.status === "passed" ? "passed" : "pending",
    acceptedStatus
  );
};

const getProbe = async (request: Request, environment: SmokeEnvironment): Promise<Response> => {
  const probeId = new URL(request.url).searchParams.get("probeId");
  if (probeId === null || !Schema.is(SmokeWork.fields.probeId)(probeId)) return refused();
  const row = await readProbe(environment, probeId);
  return validRow(row, environment)
    ? responseFor(
        environment,
        row.value.status === "passed" ? "passed" : "pending",
        completedStatus
      )
    : fail();
};

/** Private, reserved-only protocol: it never receives a User identity or arbitrary resource key. */
export const handleSmoke = async (
  request: Request,
  environment: SmokeEnvironment
): Promise<Response> => {
  if (!smokeProofAccepted(request, environment.SMOKE_PROOF)) return refused();
  try {
    if (request.method === "POST") return await startProbe(request, environment);
    if (request.method === "GET") return await getProbe(request, environment);
    return refused();
  } catch {
    return fail();
  }
};

const receiveMessage = async (
  message: Message<unknown>,
  environment: SmokeEnvironment
): Promise<void> => {
  const decoded = Schema.decodeUnknownOption(SmokeWork)(message.body);
  if (Option.isNone(decoded)) throw new Error("Invalid smoke work");
  const work = decoded.value;
  const row = await environment.DB.prepare(
    "SELECT expires_at_ms FROM release_smoke_probes WHERE probe_id = ? AND git_revision = ?"
  )
    .bind(work.probeId, work.gitRevision)
    .first<{ expires_at_ms: number }>();
  if (row === null || row.expires_at_ms <= Date.now()) {
    message.ack();
    return;
  }
  const id = `release-smoke-${work.probeId}`;
  try {
    await environment.SMOKE_WORKFLOW.create({ id, params: work });
  } catch {
    await environment.SMOKE_WORKFLOW.get(id);
  }
  message.ack();
};

/** Only the dedicated Queue may hand off synthetic work to this Workflow. */
export const receiveSmoke = async (
  batch: MessageBatch<unknown>,
  environment: SmokeEnvironment
): Promise<void> => {
  if (batch.queue !== environment.SMOKE_QUEUE_NAME) throw new Error("Smoke queue unavailable");
  await Promise.all(batch.messages.map((message) => receiveMessage(message, environment)));
};

/** Stable Workflow name and step: no provider call, model inference, or User-owned table. */
export class ReleaseSmokeWorkflowV1 extends WorkflowEntrypoint<SmokeEnvironment, unknown> {
  run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    return observeWorkerPromise(
      async () => {
        const decoded = Schema.decodeUnknownOption(SmokeWork)(event.payload);
        if (Option.isNone(decoded)) throw new Error("Invalid smoke workflow");
        await step.do("settle-synthetic-smoke-v1", async () => {
          await this.env.DB.prepare(
            "UPDATE release_smoke_probes SET status = 'passed' WHERE probe_id = ? AND git_revision = ? AND expires_at_ms > ? AND status = 'queued'"
          )
            .bind(decoded.value.probeId, decoded.value.gitRevision, Date.now())
            .run();
        });
      },
      {
        environment: workerRelease(this.env),
        telemetry: cloudflareWorkerTelemetry,
        operation: "workflow.releaseSmoke",
      }
    );
  }
}
