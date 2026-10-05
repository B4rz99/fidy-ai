import { Miniflare } from "miniflare";
import { it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Option } from "effect";
import { afterEach, describe, expect, vi } from "vitest";
import { runOperationalAlerts as deliverAlerts } from "./operations";
import type { OperationalAlert } from "./contract";

const runOperationalAlerts = (
  input: Omit<Parameters<typeof deliverAlerts>[0], "signal">
): Promise<void> => deliverAlerts({ ...input, signal: new AbortController().signal });

const instances: Miniflare[] = [];
const database = (): Effect.Effect<D1Database, Cause.UnknownError> =>
  Effect.gen(function* () {
    const instance = new Miniflare({
      workers: [
        {
          config: {
            name: "operational-alerts",
            type: "worker",
            compatibilityDate: "2026-09-08",
            env: { DB: { id: "operational-alerts", type: "d1" } },
            manifest: {
              mainModule: "index.mjs",
              modules: {
                "index.mjs": {
                  contents: "export default {fetch() {return new Response('ok')}}",
                  type: "esm",
                },
              },
            },
          },
        },
      ],
    });
    yield* Effect.tryPromise(() => instance.ready);
    instances.push(instance);
    const db = yield* Effect.tryPromise(() => instance.getD1Database("DB"));
    yield* Effect.tryPromise(() =>
      db
        .prepare(`CREATE TABLE operational_alerts (
    kind TEXT NOT NULL, owner TEXT NOT NULL, severity TEXT NOT NULL,
    state TEXT NOT NULL, first_seen_ms INTEGER NOT NULL, last_seen_ms INTEGER NOT NULL,
    last_attempt_ms INTEGER, attempt_started_ms INTEGER, delivery_confirmed INTEGER NOT NULL DEFAULT 0,
    next_attempt_ms INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    acknowledged_ms INTEGER, PRIMARY KEY (kind, owner)
  )`)
        .run()
    );
    return db;
  });
afterEach(() =>
  Effect.runPromise(
    Effect.forEach(instances.splice(0), (instance) => Effect.tryPromise(() => instance.dispose()), {
      discard: true,
    })
  )
);

const deadLetter: OperationalAlert = {
  kind: "dead_letters",
  owner: "deadLetters",
  severity: "critical",
};

// Assertions of rejected provider calls stay inside the Effect test, without a second async runner.
const rejects = (promise: Promise<unknown>): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() => expect(promise).rejects.toThrow()).pipe(Effect.asVoid);

const accepted = (): Promise<void> => Promise.resolve();

describe("operator email notification", () => {
  it.effect("bounds independent sends at two and preserves confirmations when one send fails", () =>
    Effect.gen(function* () {
      const db = yield* database();
      const filled = yield* Deferred.make<void>();
      const release = Promise.withResolvers<void>();
      const alerts: ReadonlyArray<OperationalAlert> = [
        deadLetter,
        { kind: "worker_exception", owner: "workerExceptions", severity: "critical" },
        { kind: "resource_limit", owner: "resourceLimits", severity: "critical" },
        { kind: "callback_rejection", owner: "callbackRejections", severity: "warning" },
        { kind: "retention_lag", owner: "retention", severity: "warning" },
        { kind: "whatsapp_delivery", owner: "whatsapp", severity: "warning" },
        { kind: "capability_unusable", owner: "queueExecution", severity: "critical" },
      ];
      let active = 0;
      let maximum = 0;
      let started = 0;
      const send = (): Promise<void> => {
        const ordinal = ++started;
        maximum = Math.max(maximum, ++active);
        if (active === 2) Deferred.doneUnsafe(filled, Effect.void);
        return release.promise
          .then(() => {
            if (ordinal === alerts.length) throw new Error("notification unavailable");
          })
          .finally(() => {
            active--;
          });
      };
      const completed = runOperationalAlerts({ db, now: 1_000_000, alerts, send }).then(
        () => Exit.succeed(undefined),
        (failure: unknown) => Exit.fail(failure)
      );
      yield* Deferred.await(filled);
      yield* Effect.yieldNow;
      const held = { active, started, maximum };
      release.resolve();
      const result = yield* Effect.tryPromise(() => completed);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(result.cause.reasons).toHaveLength(1);
        expect(Cause.findErrorOption(result.cause)).toEqual(
          Option.some(new Error("Operator alert email unavailable"))
        );
      }
      expect(held).toEqual({ active: 2, started: 2, maximum: 2 });
      expect({ active, started, maximum }).toEqual({ active: 0, started: 7, maximum: 2 });
      const retained = yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT count(*) AS total, sum(delivery_confirmed) AS confirmed FROM operational_alerts"
          )
          .first()
      );
      expect(retained).toMatchObject({ total: 7, confirmed: 6 });
    })
  );
  it.effect(
    "performs no resolution persistence or send when the root signal is already aborted",
    () => {
      const controller = new AbortController();
      controller.abort();
      return Effect.gen(function* () {
        const db = yield* database();
        const prepare = vi.spyOn(db, "prepare");
        const send = vi.fn(accepted);
        const exit = yield* Effect.tryPromise(() =>
          deliverAlerts({ db, now: 1_000_000, alerts: [], send, signal: controller.signal })
        ).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(prepare).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
      });
    }
  );
  it.effect(
    "delivers a new critical alert once and repeats after thirty minutes without changing work state",
    () =>
      Effect.gen(function* () {
        const db = yield* database();
        const sent: string[] = [];
        const send = (_alert: OperationalAlert, key: string): Promise<void> => {
          sent.push(key);
          return accepted();
        };
        yield* Effect.tryPromise(() =>
          runOperationalAlerts({ db, now: 1_000_000, alerts: [deadLetter], send })
        );
        yield* Effect.tryPromise(() =>
          runOperationalAlerts({ db, now: 1_060_000, alerts: [deadLetter], send })
        );
        yield* Effect.tryPromise(() =>
          runOperationalAlerts({ db, now: 2_800_000, alerts: [deadLetter], send })
        );
        expect(sent).toHaveLength(2);
        expect(sent[0]).not.toBe(sent[1]);
      })
  );

  it.effect("does not acknowledge or silently discard an alert when delivery fails", () =>
    Effect.gen(function* () {
      const db = yield* database();
      yield* rejects(
        runOperationalAlerts({
          db,
          now: 1_000_000,
          alerts: [deadLetter],
          send: () => Promise.reject(new Error("private delivery error")),
        })
      );
      const rows = yield* Effect.tryPromise(() =>
        db.prepare("SELECT state, acknowledged_ms, attempts FROM operational_alerts").all()
      );
      expect(rows.results).toEqual([{ state: "firing", acknowledged_ms: null, attempts: 1 }]);
    })
  );

  it.effect(
    "reuses one idempotency key after an ambiguous attempt before starting another notification",
    () =>
      Effect.gen(function* () {
        const db = yield* database();
        const keys: string[] = [];
        yield* rejects(
          runOperationalAlerts({
            db,
            now: 1_000_000,
            alerts: [deadLetter],
            send: (_alert, key) => {
              keys.push(key);
              return Promise.reject(new Error("lost provider response"));
            },
          })
        );
        yield* Effect.tryPromise(() =>
          runOperationalAlerts({
            db,
            now: 2_800_000,
            alerts: [deadLetter],
            send: (_alert, key) => {
              keys.push(key);
              return accepted();
            },
          })
        );
        expect(keys).toEqual([keys[0], keys[0]]);
      })
  );

  it.effect("does not send an email after the scheduled Work is cancelled", () =>
    Effect.gen(function* () {
      const db = yield* database();
      const sent: string[] = [];
      yield* rejects(
        deliverAlerts({
          db,
          now: 1_000_000,
          alerts: [deadLetter],
          signal: AbortSignal.abort(),
          send: (_alert, key) => {
            sent.push(key);
            return accepted();
          },
        })
      );
      expect(sent).toEqual([]);
    })
  );

  it.effect(
    "starts a new operator-email attempt after the provider idempotency window instead of falling permanently silent",
    () =>
      Effect.gen(function* () {
        const db = yield* database();
        const sent: string[] = [];
        yield* rejects(
          runOperationalAlerts({
            db,
            now: 1_000_000,
            alerts: [deadLetter],
            send: (_alert, key) => {
              sent.push(key);
              return Promise.reject(new Error("lost provider response"));
            },
          })
        );
        yield* Effect.tryPromise(() =>
          runOperationalAlerts({
            db,
            now: 84_000_000,
            alerts: [deadLetter],
            send: (_alert, key) => {
              sent.push(key);
              return accepted();
            },
          })
        );
        expect(sent).toHaveLength(2);
        expect(sent[1]).not.toBe(sent[0]);
      })
  );

  it.effect("refuses an invalid alert kind/owner pair from corrupted private state", () =>
    Effect.gen(function* () {
      const db = yield* database();
      yield* Effect.tryPromise(() =>
        db
          .prepare(`INSERT INTO operational_alerts
      (kind, owner, severity, state, first_seen_ms, last_seen_ms, next_attempt_ms)
      VALUES ('callback_rejection', 'billingQueue', 'critical', 'resolved', 0, 0, 0)`)
          .run()
      );
      yield* rejects(
        runOperationalAlerts({
          db,
          now: 1_000_000,
          alerts: [],
          send: () => Promise.reject(new Error("must not send")),
        })
      );
    })
  );

  it.effect("cannot resolve authoritative incomplete work from a missing measurement", () =>
    Effect.gen(function* () {
      const db = yield* database();
      const sent: string[] = [];
      const send = (
        _alert: OperationalAlert,
        _key: string,
        delivery: Readonly<{ phase: "firing" | "resolved" }>
      ): Promise<void> => {
        sent.push(delivery.phase);
        return accepted();
      };
      yield* Effect.tryPromise(() =>
        runOperationalAlerts({ db, now: 1_000_000, alerts: [deadLetter], send })
      );
      yield* Effect.tryPromise(() =>
        runOperationalAlerts({
          db,
          now: 1_100_000,
          alerts: [{ kind: "inspection_unavailable", owner: "deadLetters", severity: "warning" }],
          send,
        })
      );
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT state FROM operational_alerts WHERE kind = 'dead_letters'").first()
        )
      ).toEqual({ state: "firing" });
      expect(sent).toEqual(["firing", "firing"]);
    })
  );

  it.effect("resolves persisted Tail-only alerts after their monitoring source is removed", () =>
    Effect.gen(function* () {
      const db = yield* database();
      yield* Effect.tryPromise(() =>
        db
          .prepare(`INSERT INTO operational_alerts
          (kind, owner, severity, state, first_seen_ms, last_seen_ms, delivery_confirmed, next_attempt_ms)
          VALUES ('worker_exception', 'workerExceptions', 'warning', 'firing', 0, 0, 1, 0)`)
          .run()
      );
      const delivered: Array<string> = [];
      yield* Effect.tryPromise(() =>
        runOperationalAlerts({
          db,
          now: 1_000_000,
          alerts: [],
          send: (alert, _key, delivery) => {
            delivered.push(`${alert.kind}:${delivery.phase}`);
            return accepted();
          },
        })
      );
      expect(delivered).toEqual(["worker_exception:resolved"]);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT state FROM operational_alerts WHERE kind = 'worker_exception'").first()
        )
      ).toEqual({ state: "resolved" });
    })
  );

  it.effect("resolves absent conditions, then notifies when the condition returns", () =>
    Effect.gen(function* () {
      const db = yield* database();
      const sent: string[] = [];
      const send = (
        _alert: OperationalAlert,
        key: string,
        delivery: Readonly<{ phase: "firing" | "resolved" }>
      ): Promise<void> => {
        sent.push(`${delivery.phase}:${key}`);
        return accepted();
      };
      yield* Effect.tryPromise(() =>
        runOperationalAlerts({ db, now: 1_000_000, alerts: [deadLetter], send })
      );
      yield* Effect.tryPromise(() =>
        runOperationalAlerts({ db, now: 1_100_000, alerts: [], send })
      );
      yield* Effect.tryPromise(() =>
        runOperationalAlerts({ db, now: 1_150_000, alerts: [], send })
      );
      yield* Effect.tryPromise(() =>
        runOperationalAlerts({ db, now: 1_200_000, alerts: [deadLetter], send })
      );
      expect(sent.map((value) => value.split(":")[0])).toEqual(["firing", "resolved", "firing"]);
    })
  );
});
