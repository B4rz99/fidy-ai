import { Effect, Option, Schema } from "effect";
import { beforeEach, vi } from "vitest";
import coreWorker, { type makeCoreWorker } from "./core-worker";
import * as core from "./core-worker";
import { observeBrowserCost } from "./browser-cost/operations";
import { operationCatalog } from "../src/shell/api";
import { matchesRouteTemplate } from "../src/shell/public-http/operations";
import * as canonical from "./canonical-operations/operations";
import * as insights from "./insights/operations";
import * as browserLogin from "./browser-login/operations";

type Worker = ReturnType<typeof makeCoreWorker>;
type Database = Parameters<Worker["fetch"]>[1]["DB"];
const recordCodec = Schema.fromJsonString(
  Schema.Struct({
    operation: Schema.String,
    status: Schema.Int,
    latencyMilliseconds: Schema.Finite,
    hostProcessCpuMilliseconds: Schema.Finite,
    rowsRead: Schema.Finite,
    rowsWritten: Schema.Finite,
    coordinatorCalls: Schema.Int,
    costBoundary: Schema.String,
    timingBoundary: Schema.String,
  })
);
const microsecondsPerMillisecond = Number("1000");
const wrap =
  (fetch: Worker["fetch"]): Worker["fetch"] =>
  (request, environment, context) =>
    Effect.gen(function* () {
      const path = new URL(request.url).pathname;
      const operation = operationCatalog.operations.find(
        (candidate) =>
          candidate.method === request.method &&
          matchesRouteTemplate({ template: candidate.route, path })
      );
      if (operation === undefined) {
        return yield* Effect.tryPromise(() => fetch(request, environment, context));
      }
      const observed = observeBrowserCost(environment.DB);
      let coordinatorCalls = 0;
      const coordinator = environment.USER_TRANSACTION_COORDINATOR;
      const started = performance.now();
      const cpuStarted = process.cpuUsage();
      const response = yield* Effect.tryPromise(() =>
        fetch(
          request,
          {
            ...environment,
            DB: observed.database,
            USER_TRANSACTION_COORDINATOR: {
              getByName: (
                name
              ): ReturnType<
                Parameters<Worker["fetch"]>[1]["USER_TRANSACTION_COORDINATOR"]["getByName"]
              > => {
                const object = coordinator.getByName(name);
                return {
                  fetch: (...arguments_: Parameters<typeof object.fetch>) => {
                    coordinatorCalls += 1;
                    return object.fetch(...arguments_);
                  },
                };
              },
            },
          },
          context
        )
      );
      const elapsed = performance.now() - started;
      const cpu = process.cpuUsage(cpuStarted);
      const encoded = yield* Schema.encodeEffect(recordCodec)({
        operation: operation.id,
        status: response.status,
        latencyMilliseconds: elapsed,
        hostProcessCpuMilliseconds: (cpu.user + cpu.system) / microsecondsPerMillisecond,
        ...observed.cost(),
        coordinatorCalls,
        costBoundary: "direct Core D1 binding only; coordinator/provider work excluded",
        timingBoundary:
          "native integration fixture; host-process CPU excludes workerd and is not Worker CPU",
      });
      yield* Effect.sync(() => process.stdout.write(`INFRA_REQUEST ${encoded}\n`));
      return response;
    }).pipe(Effect.orDie, Effect.runPromise);
const factory = core.makeCoreWorker;
const originalFetch = coreWorker.fetch;
const executeWork = canonical.executeCanonicalWork;
const executeQuery = canonical.executeCanonicalQuery;
const readReminder = insights.readCanonicalReminderSchedule;
const readDigest = insights.readCanonicalRecurringDigestReport;
const approvePairing = browserLogin.approveBrowserPairing;
const hostedCall = canonical.executeHostedStatementCall;
const measureOwner = <A, E, R>(
  input: Readonly<{
    db: Database;
    operation: string;
    execute: (db: Database) => Effect.Effect<A, E, R>;
    response: (value: A) => Option.Option<Response>;
  }>
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const observed = observeBrowserCost(input.db);
    const started = performance.now();
    const cpuStarted = process.cpuUsage();
    const result = yield* input.execute(observed.database);
    const elapsed = performance.now() - started;
    const cpu = process.cpuUsage(cpuStarted);
    const response = input.response(result);
    const encoded = yield* Schema.encodeEffect(recordCodec)({
      operation: input.operation,
      status: Option.isSome(response) ? response.value.status : 0,
      latencyMilliseconds: elapsed,
      hostProcessCpuMilliseconds: (cpu.user + cpu.system) / microsecondsPerMillisecond,
      ...observed.cost(),
      coordinatorCalls: 0,
      costBoundary: "held canonical owner D1 binding; transport admission excluded",
      timingBoundary:
        "owner integration fixture; host-process CPU excludes workerd and is not Worker CPU",
    }).pipe(Effect.orDie);
    yield* Effect.sync(() => process.stdout.write(`INFRA_OWNER ${encoded}\n`));
    return result;
  });
const installObservers = (): void => {
  vi.spyOn(browserLogin, "approveBrowserPairing").mockImplementation((input) =>
    measureOwner({
      db: input.db,
      operation: "browserLogin.approvePairing",
      execute: (db) => approvePairing({ ...input, db }),
      response: Option.some,
    })
  );
  vi.spyOn(canonical, "executeHostedStatementCall").mockImplementation((input) =>
    measureOwner({
      db: input.db,
      operation: input.operation,
      execute: (db) => hostedCall({ ...input, db }),
      response: Option.some,
    })
  );
  vi.spyOn(insights, "readCanonicalReminderSchedule").mockImplementation((input) =>
    measureOwner({
      db: input.db,
      operation: "insights.getReminderSchedule",
      execute: (db) => readReminder({ ...input, db }),
      response: Option.some,
    })
  );
  vi.spyOn(insights, "readCanonicalRecurringDigestReport").mockImplementation((input) =>
    measureOwner({
      db: input.db,
      operation: "insights.getRecurringDigestReport",
      execute: (db) => readDigest({ ...input, db }),
      response: Option.some,
    })
  );
  vi.spyOn(coreWorker, "fetch").mockImplementation(wrap(originalFetch));
  vi.spyOn(core, "makeCoreWorker").mockImplementation((...arguments_) => {
    const worker = factory(...arguments_);
    return { ...worker, fetch: wrap(worker.fetch) };
  });
  vi.spyOn(canonical, "executeCanonicalWork").mockImplementation((input) =>
    measureOwner({
      db: input.db,
      operation:
        input.work._tag === "Call" ? input.work.operation : "operations.executeAtomicBatch",
      execute: (db) => executeWork({ ...input, db }),
      response: Option.some,
    })
  );
  vi.spyOn(canonical, "executeCanonicalQuery").mockImplementation((input) =>
    measureOwner({
      db: input.db,
      operation: input.operation,
      execute: (db) => executeQuery({ ...input, db }),
      response: (value) => value,
    })
  );
};
installObservers();
beforeEach(installObservers);
