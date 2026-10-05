import type { APIRequestContext, Page } from "@playwright/test";
import { BunFileSystem } from "@effect/platform-bun";
import { Data, Effect, FileSystem, Option, Predicate, Record, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { PublicOutput } from "../../cli/src/command/contract";
import {
  type ProcessUnavailable,
  type TestProcess,
  scopedProcess,
} from "../../cli/test/process.test-fixture";
import { cleanupJourney, scopedJourney } from "./cli-scope.test-fixture";
import { playwright } from "./playwright-runtime";
import { signInThroughCore } from "./real-core-fixture";

const { expect, test } = playwright;
if (Bun.env.CLI_ACCEPTANCE_MODE !== "cli") {
  throw new Error(
    "The native CLI journey requires bun run test:browser:cli and its isolated topology."
  );
}
class CliJourneyFailed extends Data.TaggedError("CliJourneyFailed") {}
const wait = <A>(promise: Promise<A>): Effect.Effect<A, CliJourneyFailed> =>
  Effect.tryPromise({ try: () => promise, catch: () => new CliJourneyFailed() });
const entry = Bun.fileURLToPath(new URL("../../cli/test/journey-entry.ts", import.meta.url));
const outputCodec = Schema.fromJsonString(Schema.toCodecJson(PublicOutput));
const maximumOutputBytes = 16_384;
// Playwright does not cancel a timed-out callback. Interrupt the body while its Scope is
// still owned here; reserve 20s for child escalation and two bounded native cleanup runs.
const playwrightTimeout = 90_000;
const journeyBudget = 40_000;
const cleanupBudget = 5_000;
const teardownReserve = 20_000;
// This single-test file is evaluated before fixture setup: charging all time since load
// conservatively includes setup without using Playwright's private timeout manager.
const loadedAt = performance.now();
type Complete = (
  args: ReadonlyArray<string>
) => Effect.Effect<string, CliJourneyFailed | ProcessUnavailable>;
type Invoke = (
  group: string,
  operation: string,
  input: Schema.Json
) => Effect.Effect<
  string,
  CliJourneyFailed | ProcessUnavailable | Schema.SchemaError | PlatformError
>;

const firstOutput = Effect.fn(function* (child: TestProcess) {
  const chunk = yield* child.read;
  if (Option.isNone(chunk) || chunk.value.byteLength > maximumOutputBytes) {
    return yield* new CliJourneyFailed();
  }
  const output = yield* Schema.decodeEffect(outputCodec, { onExcessProperty: "error" })(
    new TextDecoder().decode(chunk.value).trim()
  );
  if (output._tag !== "ApprovalRequired") return yield* new CliJourneyFailed();
  return output;
});
const finished = Effect.fn(function* (child: TestProcess) {
  let output = "";
  let bytes = 0;
  let chunk = yield* child.read;
  while (Option.isSome(chunk)) {
    bytes += chunk.value.byteLength;
    if (bytes > maximumOutputBytes) return yield* new CliJourneyFailed();
    output += new TextDecoder().decode(chunk.value);
    chunk = yield* child.read;
  }
  expect(yield* child.exited).toBe(0);
  expect(output.includes("fin_")).toBe(false);
  return output;
});

const journeyEnvironment = (directory: string, service: string): Readonly<Record<string, string>> =>
  Record.filter(
    {
      PATH: Bun.env.PATH,
      HOME: Bun.env.HOME,
      USERPROFILE: Bun.env.USERPROFILE,
      SYSTEMROOT: Bun.env.SYSTEMROOT,
      DBUS_SESSION_BUS_ADDRESS: Bun.env.DBUS_SESSION_BUS_ADDRESS,
      XDG_RUNTIME_DIR: Bun.env.XDG_RUNTIME_DIR,
      CLI_ACCEPTANCE_MODE: Bun.env.CLI_ACCEPTANCE_MODE,
      CLI_JOURNEY_DIRECTORY: directory,
      CLI_JOURNEY_SERVICE: service,
    },
    Predicate.isString
  );

const queryJourney = Effect.fn(function* (complete: Complete, invoke: Invoke) {
  const status = yield* complete(["status"]);
  expect(status).toContain('"availability":"available"');
  expect(status).toContain('"scopes":["read","write","dashboard"]');
  expect(status).toContain('"lifetimeDays":7');
  const categories = yield* complete(["categories", "listCategories"]);
  expect(categories).toContain('"label":"Restaurantes"');
  const transactions = yield* complete(["transactions", "listTransactions", "--currency", "COP"]);
  expect(transactions).toBe(
    yield* invoke("transactions", "listTransactions", { query: { currency: "COP" } })
  );
  expect(transactions).toContain('"data":');
  expect(transactions).toContain('"next":');
  const result = yield* Schema.decodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        data: Schema.NonEmptyArray(Schema.Struct({ id: Schema.String })),
      })
    )
  )(categories.trim());
  return result.data[0].id;
});
const transactionFacts = (categoryId: string, notes: string): Schema.Json => ({
  money: { amount: "9007199254740993.15", currency: "USD" },
  direction: "outflow",
  categoryId,
  occurredAt: "2026-01-01T12:00:00.000Z",
  notes,
});
const mutationJourney = Effect.fn(function* (
  complete: Complete,
  invoke: Invoke,
  categoryId: string
) {
  const created = yield* complete([
    "transactions",
    "createTransaction",
    "--amount",
    "9007199254740993.15",
    "--currency",
    "USD",
    "--direction",
    "outflow",
    "--category-id",
    categoryId,
    "--occurred-at",
    "2026-01-01T12:00:00.000Z",
  ]);
  expect(created).toContain('"amount":"9007199254740993.15"');
  expect(created).toContain('"direction":"outflow"');
  expect(yield* complete(["dashboard", "initializeDashboard"])).toContain('"title":"Tablero"');
  expect(
    yield* invoke("dashboard", "applyDashboardEdit", {
      payload: { op: "set-title", title: "CLI edit" },
    })
  ).toContain('"title":"CLI edit"');
});
const batchJourney = Effect.fn(function* (complete: Complete, invoke: Invoke, categoryId: string) {
  const callIds = [
    "01900000-0000-4000-8000-000000000001",
    "01900000-0000-4000-8000-000000000002",
  ] as const;
  const batched = yield* invoke("operations", "executeAtomicBatch", {
    payload: {
      calls: [
        {
          callId: callIds[0],
          operation: "transactions.createTransaction",
          input: {
            payload: transactionFacts(categoryId, "CLI batch"),
          },
        },
        {
          callId: callIds[1],
          operation: "dashboard.applyDashboardEdit",
          input: {
            payload: { op: "set-title", title: "CLI batch edit" },
          },
        },
      ],
    },
  });
  expect(batched).toContain('"notes":"CLI batch"');
  expect(batched).toContain('"title":"CLI batch edit"');
  const ordered = yield* Schema.decodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        data: Schema.Struct({ results: Schema.Array(Schema.Struct({ callId: Schema.String })) }),
      })
    )
  )(batched.trim());
  expect(ordered.data.results.map(({ callId }) => callId)).toEqual(callIds);
  expect(yield* complete(["dashboard", "getDashboard"])).toContain('"title":"CLI batch edit"');
});
const auditJourney = Effect.fn(function* (request: APIRequestContext) {
  const audit = yield* wait(request.get("http://127.0.0.1:4185/cli/evidence"));
  const successStatus = 200;
  expect(audit.status()).toBe(successStatus);
  const evidence = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      entries: Schema.Array(
        Schema.Struct({ operation: Schema.String, outcome: Schema.String, patId: Schema.String })
      ),
    })
  )(yield* wait(audit.json()));
  expect(
    evidence.entries.filter(
      ({ operation, outcome }) =>
        operation === "transactions.createTransaction" && outcome === "accepted"
    )
  ).toHaveLength(2);
  expect(
    evidence.entries.filter(
      ({ operation, outcome }) =>
        operation === "dashboard.initializeDashboard" && outcome === "accepted"
    )
  ).toHaveLength(1);
  expect(
    evidence.entries.filter(
      ({ operation, outcome }) =>
        operation === "dashboard.applyDashboardEdit" && outcome === "accepted"
    )
  ).toHaveLength(2);
  expect(new Set(evidence.entries.map(({ patId }) => patId)).size).toBe(1);
});

const cliJourney = Effect.fn(function* ({
  page,
  request,
}: Readonly<{ page: Page; request: APIRequestContext }>) {
  yield* wait(signInThroughCore({ page, request }));
  const filesystem = yield* FileSystem.FileSystem;
  const directory = yield* filesystem.makeTempDirectoryScoped();
  const service = `com.fidy.cli.journey.${process.pid}-${Bun.nanoseconds()}`;
  const env = journeyEnvironment(directory, service);
  const spawn = (args: ReadonlyArray<string>): ReturnType<typeof scopedProcess> =>
    scopedProcess([process.execPath, entry, ...args], env);
  const complete: Complete = (args) =>
    Effect.gen(function* () {
      return yield* finished(yield* spawn(args));
    }).pipe(Effect.scoped);
  const invoke: Invoke = Effect.fn(function* (group, operation, input) {
    const path = `${directory}/request.json`;
    yield* filesystem.writeFileString(
      path,
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(input)
    );
    return yield* complete([group, operation, "--input", path]);
  });
  // Registered before children: their kill-and-await finalizers run before native cleanup.
  yield* Effect.addFinalizer(() =>
    cleanupJourney(complete(["logout"]), complete(["cleanup"]), cleanupBudget)
  );
  const child = yield* spawn([
    "login",
    "--recipient",
    "CLI de prueba",
    "--scopes",
    "read,write,dashboard",
    "--lifetime",
    "7",
  ]);
  const approval = yield* firstOutput(child);
  yield* wait(page.goto("/settings/pats"));
  yield* wait(page.getByLabel("Código", { exact: true }).fill(approval.publicCode));
  yield* wait(page.getByRole("button", { name: "Continuar" }).click());
  yield* wait(expect(page.getByText("CLI de prueba").first()).toBeVisible());
  yield* wait(page.getByRole("button", { name: "Autorizar acceso" }).click());
  yield* wait(expect(page.getByText("Acceso autorizado")).toBeVisible());
  expect(yield* finished(child)).toContain("LoggedIn");
  const categoryId = yield* queryJourney(complete, invoke);
  yield* mutationJourney(complete, invoke, categoryId);
  yield* batchJourney(complete, invoke, categoryId);
  yield* auditJourney(request);
});

test.setTimeout(playwrightTimeout);

test("a web-approved native CLI login queries, mutates and batches through real public/Core with attributable Audit", ({
  page,
  request,
}) => {
  const remaining = playwrightTimeout - (performance.now() - loadedAt) - teardownReserve;
  if (remaining <= 0) throw new CliJourneyFailed();
  return Effect.runPromise(
    scopedJourney(cliJourney({ page, request }), Math.min(journeyBudget, remaining)).pipe(
      Effect.provide(BunFileSystem.layer)
    )
  );
});
