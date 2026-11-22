import { recoverLocalReceipts } from "../canonical-admission/operations";
import { type BillingObservationWorkflow, type BillingWorkRouting } from "./contract";
import { handleSourceCancellationWork } from "./runtime";
import { receiveLocalSourceCancellation } from "./internal/billing-observation";
import { observeCancellation } from "./internal/local-cancellation";
import { UserId } from "../../src/core/identity/contract";
import { BillingAttemptId } from "../../src/core/subscription/contract";
import { DurableObject } from "cloudflare:workers";
import { Effect, Option, Predicate, Result } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { createStoreRuntime, openSqliteStore } from "../runtime/sqlite/operations";
import { recoverUserWork, userStoreHistory } from "../user-store/operations";
import { offerDueSourceCancellations, retainSubscriptionCancellation } from "./operations";

const user = "22370000-0000-4000-8000-000000000001";

const subscription = "22370000-0000-4000-8000-000000000002";

const source = "22370000-0000-4000-8000-000000000003";

const attempt = "22370000-0000-4000-8000-000000000004";

const digestCharacters = 64;

const oneSecond = 1_000;

const cooldown = 60_000;

const providerSource = 78001;

const otherSource = 78002;

const unavailable = 503;

const success = 200;

const scheduled = 2_000_000_000_000;

export class CancellationFixture extends DurableObject<unknown> {
  private readonly runtime;
  constructor(state: DurableObjectState, env: unknown) {
    super(state, env);

    const history =
      state.id.name === "v4"
        ? { ...userStoreHistory, steps: userStoreHistory.steps.slice(0, 4) }
        : userStoreHistory;

    this.runtime = createStoreRuntime({
      storage: state.storage,
      owner: "user",
      ceilingBytes: "1000000000",
    });
    state.waitUntil(
      state.blockConcurrencyWhile(() =>
        this.runtime.runPromise(openSqliteStore(history, "fixture"))
      )
    );
  }
  alarm(): Promise<void> {
    return Promise.resolve();
  }
  override fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;

    if (path === "/seed-page") return this.runtime.runPromise(seedPage);

    if (path === "/rebind") return this.runtime.runPromise(exerciseRebind);

    if (path === "/upgrade") return this.runtime.runPromise(upgradeReceipt);
    const storage = this.ctx.storage;

    return this.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqliteClient;

        if (path === "/seed") {
          yield* sql`INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (${user},'CO','es-CO','America/Bogota',0)`;
          yield* sql`INSERT INTO subscriptions(id,user_id) VALUES (${subscription},${user})`;
          yield* sql`INSERT INTO payment_sources(id,subscription_id,method,wompi_environment,wompi_source_id) VALUES (${source},${subscription},'daviplata','sandbox',78001)`;
          yield* sql`INSERT INTO billing_attempts(id,subscription_id,payment_source_id,paid_starts_at_ms,paid_ends_at_ms,wompi_environment) VALUES (${attempt},${subscription},${source},1,${scheduled + oneSecond},'sandbox')`;
          yield* sql`UPDATE subscriptions SET current_paid_attempt_id=${attempt} WHERE id=${subscription}`;
        }

        if (["/accept", "/fail"].includes(path)) {
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const value = yield* retainSubscriptionCancellation({
                  userId: user,
                  current: scheduled,
                  storage,
                });

                if (Option.isNone(value)) return yield* Effect.fail("paid Subscription missing");

                if (path === "/fail") return yield* Effect.fail("receipt write interrupted");
              })
            )
            .pipe(Effect.exit);
        }

        if (path === "/earlier") {
          yield* Effect.tryPromise(() => storage.setAlarm(scheduled - oneSecond));
        }

        if (["/poison", "/exhausted", "/native-retry", "/recover-families"].includes(path)) {
          return yield* exerciseRecovery(path, storage);
        }

        if (path.startsWith("/dispatch")) return yield* exerciseDispatch(path, storage);

        if (path === "/queue") return yield* exerciseQueue;

        if (path.startsWith("/observe-")) return yield* exerciseProvider(path);

        const rows =
          yield* sql`SELECT source_cancellation_state AS state, paid_through_ms, paid_attempt_id FROM subscription_cancellations`;

        return Response.json({ rows, alarm: yield* Effect.tryPromise(() => storage.getAlarm()) });
      })
    );
  }
}

const seedPage = Effect.gen(function* () {
  const sql = yield* SqliteClient;
  yield* sql`WITH RECURSIVE periods(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM periods WHERE n<34)
    INSERT INTO billing_attempts(id,subscription_id,payment_source_id,paid_starts_at_ms,paid_ends_at_ms,wompi_environment)
    SELECT printf('32370000-0000-4000-8000-%012d',n),${subscription},${source},n,n+1,'sandbox' FROM periods`;
  yield* sql`INSERT INTO subscription_cancellations(paid_attempt_id,subscription_id,payment_source_id,cancelled_at_ms,paid_through_ms,source_cancellation_state,next_offer_at_ms)
    SELECT id,subscription_id,payment_source_id,${scheduled},paid_ends_at_ms,'void-pending',${scheduled} FROM billing_attempts WHERE id<>${attempt}`;

  return Response.json(null);
});

const exerciseRebind = Effect.gen(function* () {
  const sql = yield* SqliteClient;

  const bound = yield* Effect.result(
    sql`UPDATE payment_sources SET wompi_source_id=78002 WHERE id=${source}`
  );

  return Response.json({ rebound: Result.isSuccess(bound) });
});

const exerciseQueue = Effect.gen(function* () {
  const work = {
    version: 3 as const,
    kind: "source-cancellation" as const,
    userId: UserId.make(user),
    paidAttemptId: BillingAttemptId.make(attempt),
  };

  let created = 0,
    restarted = 0,
    instance = "";

  let status: InstanceStatus["status"] = "queued";

  const workflow: BillingObservationWorkflow = {
    create: (input: { id: string }) => {
      created++;
      instance = input.id;

      return Promise.resolve();
    },
    get: (id: string) => {
      if (id !== instance) return Promise.reject(new Error("No such Workflow"));

      return Promise.resolve({
        status: () => Promise.resolve({ status }),
        restart: () => {
          restarted++;
          status = "queued";

          return Promise.resolve();
        },
      });
    },
  };

  const run = Effect.runPromiseWith(
    yield* Effect.context<Effect.Services<ReturnType<typeof handleSourceCancellationWork>>>()
  );

  const environment: BillingWorkRouting = {
    USER_STORE: {
      getByName: (name) => ({
        fetch: (call, init) =>
          run(
            handleSourceCancellationWork({
              request: new Request(call, init),
              owns: (requested) => requested === name && name === user,
              environment: {
                WOMPI_ENVIRONMENT: "sandbox",
                WOMPI_PRIVATE_KEY: "",
                WOMPI_PUBLIC_KEY: "",
                WOMPI_INTEGRITY_SECRET: "",
              },
            })
          ),
      }),
    },
  };

  const offer = receiveLocalSourceCancellation({ environment, workflow, work });
  yield* offer;
  yield* offer;
  status = "unknown";
  const uncertain = yield* Effect.result(offer);
  status = "errored";
  yield* offer;

  return Response.json({ instance, created, restarted, retryUnknown: Result.isFailure(uncertain) });
});

const exerciseProvider = Effect.fnUntraced(function* (path: string) {
  const ticks = new Map([
    ["/observe-foreign", 1],
    ["/observe-confirmed", 2],
  ]);

  const tick = ticks.get(path) ?? 0;
  let sends = 0;
  yield* observeCancellation({
    work: {
      version: 3,
      kind: "source-cancellation",
      userId: UserId.make(user),
      paidAttemptId: BillingAttemptId.make(attempt),
    },
    current: scheduled + tick * cooldown,
    environment: "sandbox",
    http: {
      execute: (message) => {
        if (Predicate.isTagged(message, "WompiVoidPaymentSource")) sends++;
        const id = path === "/observe-foreign" ? otherSource : providerSource;

        return Effect.succeed({
          status: path === "/observe-lost" ? unavailable : success,
          headers: {},
          body: new TextEncoder().encode(
            JSON.stringify({ data: { id, type: "DAVIPLATA", status: "VOIDED" } })
          ),
        });
      },
    },
  }).pipe(Effect.exit);
  const sql = yield* SqliteClient;

  const [observed] =
    yield* sql`SELECT source_cancellation_state AS state,verification_count AS count FROM subscription_cancellations`;

  return Response.json({ ...observed, sends });
});

const exerciseDispatch = Effect.fnUntraced(function* (path: string, storage: DurableObjectStorage) {
  if (path !== "/dispatch") yield* Effect.tryPromise(() => storage.deleteAlarm());
  const offered: unknown[] = [];

  const result = yield* offerDueSourceCancellations({
    storage,
    current: path === "/dispatch-later" ? scheduled + cooldown : scheduled,
    queue: {
      send: (message) => {
        offered.push(message);

        return path === "/dispatch-failed"
          ? Promise.reject(new Error("queue unavailable"))
          : Promise.resolve();
      },
    },
  });

  return Response.json({
    offered: path === "/dispatch-failed" ? result.failed : offered,
    alarm: yield* Effect.tryPromise(() => storage.getAlarm()),
  });
});

const exerciseRecovery = Effect.fnUntraced(function* (path: string, storage: DurableObjectStorage) {
  const sql = yield* SqliteClient;

  if (path === "/poison") {
    yield* sql`CREATE TRIGGER fail_due BEFORE UPDATE OF next_offer_at_ms ON subscription_cancellations BEGIN SELECT RAISE(ABORT,'unavailable'); END`;

    return Response.json(null);
  }

  if (path === "/exhausted") {
    yield* sql`DROP TRIGGER fail_due`;
    yield* Effect.tryPromise(() => storage.deleteAlarm());

    return Response.json(null);
  }

  if (path === "/recover-families") {
    yield* sql`INSERT INTO canonical_request_receipts(user_id,retry_key_digest,operation,input_digest,accepted_at_ms,status,body)
      VALUES (${user},${"0".repeat(digestCharacters)},'transactions.createTransaction',${"1".repeat(digestCharacters)},0,200,NULL)`;
    yield* sql`CREATE TRIGGER fail_receipt BEFORE DELETE ON canonical_request_receipts BEGIN SELECT RAISE(ABORT,'unavailable'); END`;
  }

  let recovered = "";

  const real = offerDueSourceCancellations({
    current: scheduled,
    storage,
    queue: {
      send: (work) => {
        recovered = work.paidAttemptId;

        return Promise.resolve();
      },
    },
  });

  const result = yield* recoverUserWork(
    path === "/recover-families" ? [recoverLocalReceipts(scheduled, storage), real] : [real]
  );

  return Response.json({
    ...result,
    recovered,
    alarm: yield* Effect.tryPromise(() => storage.getAlarm()),
  });
});

const upgradeReceipt = Effect.gen(function* () {
  const sql = yield* SqliteClient;
  yield* sql`INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (${user},'CO','es-CO','America/Bogota',0)`;
  yield* sql`INSERT INTO canonical_request_receipts VALUES (${user},${"a".repeat(digestCharacters)},'transactions.createTransaction',${"b".repeat(digestCharacters)},123,201,'{"data":"capture"}')`;
  const read = sql`SELECT accepted_at_ms,status,body FROM canonical_request_receipts WHERE retry_key_digest=${"a".repeat(digestCharacters)}`;
  const [before] = yield* read;
  yield* openSqliteStore(userStoreHistory, "upgrade");
  const [after] = yield* read;

  const forbidden = yield* Effect.result(
    sql`INSERT INTO canonical_request_receipts VALUES (${user},${"c".repeat(digestCharacters)},'tokens.createPAT',${"d".repeat(digestCharacters)},124,201,'{"data":"private"}')`
  );

  return Response.json({ before, after, unsafeRetained: Result.isSuccess(forbidden) });
});
