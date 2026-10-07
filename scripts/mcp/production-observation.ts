import { Effect, Schema } from "effect";
import { VerificationFailure, attempt, command, requireCheck } from "./production-fixture";
import type { ApprovedScope } from "./production-fixture";

const streamByteLimit = 64_000_000;
const frameByteLimit = 2_000_000;
const eventLimit = 10_000;
const Deployments = Schema.Array(
  Schema.Struct({
    versions: Schema.Array(Schema.Struct({ version_id: Schema.String, percentage: Schema.Finite })),
  })
);
const deploymentVersions = Effect.fn(function* (scope: ApprovedScope, worker: string) {
  const output = yield* command(
    [
      process.execPath,
      "node_modules/wrangler/bin/wrangler.js",
      "deployments",
      "list",
      "--name",
      worker,
      "--json",
    ],
    process.cwd(),
    { CLOUDFLARE_ACCOUNT_ID: scope.accountId }
  );
  return yield* Schema.decodeEffect(Schema.fromJsonString(Deployments))(output).pipe(
    Effect.mapError(
      () => new VerificationFailure({ message: "Deployment provenance unavailable or invalid" })
    )
  );
});
export const verifyProvenance = Effect.fn(function* (scope: ApprovedScope) {
  const revision = yield* command(
    ["gh", "api", "repos/B4rz99/fidy-ai/commits/trunk", "--jq", ".sha"],
    process.cwd()
  );
  yield* requireCheck(
    revision.trim() === scope.revision,
    "Production revision differs from approved scope"
  );
  for (const surface of ["core", "ingress"] as const) {
    const deployed = yield* deploymentVersions(scope, scope.workers[surface]);
    const expected = surface === "core" ? scope.coreVersion : scope.ingressVersion;
    yield* requireCheck(
      matchesDeployment(deployed, expected),
      "Deployed Worker version differs from approved scope"
    );
  }
});
const matchesDeployment = (deployed: typeof Deployments.Type, expected: string): boolean => {
  // The pinned Wrangler deployments list JSON is sorted by creation time, oldest first.
  const versions = deployed.at(-1)?.versions ?? [];
  return (
    versions.length === 1 && versions[0]?.version_id === expected && versions[0].percentage === 100
  );
};
const TailRecord = Schema.Struct({
  outcome: Schema.String,
  cpuTime: Schema.optionalKey(Schema.Finite),
  event: Schema.optionalKey(
    Schema.Struct({
      request: Schema.optionalKey(Schema.Struct({ url: Schema.String, method: Schema.String })),
    })
  ),
  scriptVersion: Schema.optionalKey(Schema.Struct({ id: Schema.String })),
  exceptions: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});
type Surface = "core" | "ingress";
export type TailSummary = {
  readonly surface: Surface;
  readonly outcome: string;
  readonly cpuTime: number;
  readonly version: string;
  readonly route: string;
  readonly exceptions: number;
};
export type Observation = {
  readonly rows: Array<TailSummary>;
  readonly failures: Array<string>;
  readonly ingressRequests: () => number;
};
const routeFamily = (url: string): string => {
  const path = new URL(url).pathname;
  return ["/mcp", "/oauth-mcp", "/oauth/token", "/oauth/register", "/oauth/authorize"].includes(
    path
  )
    ? path
    : "other";
};
type FrameState = { depth: number; quoted: boolean; escaped: boolean };
const advanceFrame = (state: FrameState, character: string): void => {
  if (state.quoted) {
    if (state.escaped) state.escaped = false;
    else if (character === "\\") state.escaped = true;
    else if (character === '"') state.quoted = false;
    return;
  }
  if (character === '"') state.quoted = true;
  else if (character === "{") state.depth += 1;
  else if (character === "}") state.depth -= 1;
};
const frameEnd = (buffer: string): number => {
  const state: FrameState = { depth: 0, quoted: false, escaped: false };
  for (let position = 0; position < buffer.length; position++) {
    advanceFrame(state, buffer.charAt(position));
    if (state.depth === 0 && !state.quoted) return position;
  }
  return -1;
};
const retainEvent = Effect.fn(function* (surface: Surface, body: string, observation: Observation) {
  const event = yield* Schema.decodeEffect(Schema.fromJsonString(TailRecord))(body).pipe(
    Effect.mapError(
      () => new VerificationFailure({ message: "Worker observation event was invalid" })
    )
  );
  yield* requireCheck(
    observation.rows.length < eventLimit,
    "Worker observation exceeded its event bound"
  );
  const route = yield* Effect.try({
    try: () => routeFamily(event.event?.request?.url ?? "https://api.fidyapp.com/"),
    catch: () => new VerificationFailure({ message: "Worker observation route was invalid" }),
  });
  observation.rows.push({
    surface,
    outcome: event.outcome,
    cpuTime: event.cpuTime ?? -1,
    version: event.scriptVersion?.id ?? "",
    route,
    exceptions: event.exceptions?.length ?? 0,
  });
});
const drainFrames = Effect.fn(function* (
  surface: Surface,
  incoming: string,
  observation: Observation
) {
  let buffer = incoming;
  for (;;) {
    const start = buffer.indexOf("{");
    if (start < 0) return "";
    buffer = buffer.slice(start);
    const end = frameEnd(buffer);
    if (end < 0) return buffer;
    yield* retainEvent(surface, buffer.slice(0, end + 1), observation);
    buffer = buffer.slice(end + 1);
  }
});
const readEvents = Effect.fn(function* (
  surface: Surface,
  reader: Readonly<{
    read: () => Promise<Readonly<{ done: true }> | Readonly<{ done: false; value: Uint8Array }>>;
  }>,
  observation: Observation
) {
  let buffer = "";
  let consumedBytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  for (;;) {
    const part = yield* attempt("Worker observation stream failed", () => reader.read());
    if (part.done) break;
    consumedBytes += part.value.byteLength;
    yield* requireCheck(
      consumedBytes <= streamByteLimit,
      "Worker observation exceeded its byte bound"
    );
    buffer += yield* Effect.try({
      try: () => decoder.decode(part.value, { stream: true }),
      catch: () => new VerificationFailure({ message: "Worker observation encoding was invalid" }),
    });
    yield* requireCheck(
      encoder.encode(buffer).byteLength <= frameByteLimit,
      "Worker observation frame exceeded its byte bound"
    );
    buffer = yield* drainFrames(surface, buffer, observation);
  }
  observation.failures.push("Worker observation ended before verification finished");
});
const stopObservation = (owned: Bun.Subprocess): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (owned.exitCode === null) owned.kill();
    yield* attempt("Worker observation did not stop", () => owned.exited).pipe(
      Effect.timeoutOption("2 seconds")
    );
    if (owned.exitCode === null) owned.kill("SIGKILL");
    yield* attempt("Worker observation did not stop", () => owned.exited).pipe(
      Effect.timeout("2 seconds")
    );
  }).pipe(Effect.orDie);
const observe = Effect.fn(function* (
  input: { readonly surface: Surface; readonly worker: string; readonly accountId: string },
  observation: Observation
) {
  const { surface, worker, accountId } = input;
  const child = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.spawn(
        [
          process.execPath,
          "node_modules/wrangler/bin/wrangler.js",
          "tail",
          worker,
          "--format",
          "json",
        ],
        {
          env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
          stdout: "pipe",
          stderr: "ignore",
        }
      )
    ),
    stopObservation
  );
  const reader = yield* Effect.acquireRelease(
    Effect.sync(() => child.stdout.getReader()),
    (owned) =>
      attempt("Cannot cancel Worker observation", () => owned.cancel()).pipe(
        Effect.ignore,
        Effect.ensuring(Effect.sync(() => owned.releaseLock()))
      )
  );
  yield* readEvents(surface, reader, observation);
});
export const startObservation = Effect.fn(function* (scope: ApprovedScope) {
  const rows: Array<TailSummary> = [];
  const failures: Array<string> = [];
  const observation: Observation = {
    rows,
    failures,
    ingressRequests: () =>
      rows.filter((row) => row.surface === "ingress" && row.route !== "other").length,
  };
  for (const surface of ["core", "ingress"] as const) {
    yield* observe(
      { surface, worker: scope.workers[surface], accountId: scope.accountId },
      observation
    ).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          failures.push(error.message);
        })
      ),
      Effect.forkScoped
    );
  }
  yield* Effect.sleep("3 seconds");
  return observation;
});
export const checkObservation = Effect.fn(function* (
  scope: ApprovedScope,
  observation: Observation
) {
  yield* requireCheck(observation.failures.length === 0, "Worker observation failed");
  yield* requireCheck(
    observation.ingressRequests() <= scope.maximumRequests,
    "Observed OAuth/MCP request budget exceeded"
  );
  const core = observation.rows.filter((row) => row.surface === "core" && row.route === "/mcp");
  const ingress = observation.rows.filter(
    (row) => row.surface === "ingress" && row.route === "/mcp"
  );
  yield* requireCheck(
    core.length >= 2 && ingress.length >= 2,
    "Insufficient Core/ingress MCP platform observations were captured"
  );
  yield* requireCheck(
    observation.rows
      .filter((row) => row.route !== "other")
      .every(
        (row) =>
          (row.outcome === "ok" || row.outcome === "canceled") &&
          row.exceptions === 0 &&
          Number.isFinite(row.cpuTime) &&
          row.cpuTime >= 0 &&
          row.version === (row.surface === "core" ? scope.coreVersion : scope.ingressVersion)
      ),
    "OAuth/MCP platform failure or unexpected Worker version observed"
  );
});
