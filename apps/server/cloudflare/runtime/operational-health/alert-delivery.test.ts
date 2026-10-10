import { Miniflare } from "miniflare";
import { it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Option } from "effect";
import { afterAll, afterEach, describe, expect, vi } from "vitest";
import { isolatedTestStorage } from "../../d1-test-fixture";
import { runOperationalAlerts as deliverAlerts } from "./operations";
import type { OperationalAlert } from "./contract";

const runOperationalAlerts = (
  input: Omit<Parameters<typeof deliverAlerts>[0], "signal" | "outage">
): Promise<void> =>
  deliverAlerts({ ...input, outage: Option.none(), signal: new AbortController().signal });

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
            env: {
              DB: { id: "operational-alerts", type: "d1" },
            },
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
          deliverAlerts({
            db,
            now: 1_000_000,
            alerts: [],
            send,
            outage: Option.none(),
            signal: controller.signal,
          })
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
          outage: Option.none(),
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

const outageStorage = isolatedTestStorage();
afterAll(() => outageStorage.dispose());
it.effect("delivers one deduplicated D1 outage alert while claim storage is unavailable", () =>
  Effect.gen(function* () {
    const db = yield* database();
    const { bucket } = yield* Effect.tryPromise(() => outageStorage.acquire());
    yield* Effect.tryPromise(() => db.prepare("DROP TABLE operational_alerts").run());
    const sent: string[] = [];
    const input = {
      db,
      now: 1_000_000,
      alerts: [
        {
          kind: "inspection_unavailable",
          owner: "d1",
          severity: "warning",
        } satisfies OperationalAlert,
      ],
      outage: Option.some({ bucket, release: "test-release" }),
      signal: yield* Effect.abortSignal,
      send: (_alert: OperationalAlert, key: string): Promise<void> => {
        sent.push(key);
        return Promise.resolve();
      },
    };
    yield* Effect.tryPromise(() =>
      Promise.all(Array.from({ length: 8 }, () => deliverAlerts(input)))
    );
    expect(sent).toHaveLength(1);
    yield* Effect.tryPromise(() => deliverAlerts({ ...input, now: 1_060_000 }));
    expect(sent).toHaveLength(1);
    yield* Effect.tryPromise(() => deliverAlerts({ ...input, now: 2_800_000 }));
    expect(sent).toHaveLength(2);
  })
);

const outageInput = (
  db: D1Database,
  bucket: R2Bucket,
  delivery: Pick<Parameters<typeof deliverAlerts>[0], "now" | "send">
): Parameters<typeof deliverAlerts>[0] => ({
  db,
  ...delivery,
  outage: Option.some({ bucket, release: "original-release" }),
  signal: new AbortController().signal,
  alerts: [{ kind: "inspection_unavailable", owner: "d1", severity: "warning" }],
});
it.effect(
  "retries an ambiguous outage email with the original identity and release after restart",
  () =>
    Effect.gen(function* () {
      const db = yield* database();
      const { bucket } = yield* Effect.tryPromise(() => outageStorage.acquire());
      const sent: Array<Readonly<{ key: string; release: Option.Option<string> }>> = [];
      const input = outageInput(db, bucket, {
        now: 1_000_000,
        send: (_alert, key, delivery): Promise<void> => {
          sent.push({ key, release: delivery.release });
          return sent.length === 1
            ? Promise.reject(new Error("Lost provider response"))
            : Promise.resolve();
        },
      });
      yield* rejects(deliverAlerts(input));
      yield* Effect.tryPromise(() => deliverAlerts({ ...input, now: 1_060_000 }));
      expect(sent).toHaveLength(1);
      yield* Effect.tryPromise(() =>
        deliverAlerts({
          ...input,
          now: 1_300_000,
          outage: Option.some({ bucket, release: "new-release" }),
        })
      );
      expect(sent).toHaveLength(2);
      expect(sent[1]).toEqual(sent[0]);
    })
);
it.effect(
  "reports D1 recovery once and prevents rapid flapping from bypassing the repeat floor",
  () =>
    Effect.gen(function* () {
      const db = yield* database();
      const { bucket } = yield* Effect.tryPromise(() => outageStorage.acquire());
      const phases: string[] = [];
      const input = outageInput(db, bucket, {
        now: 1_000_000,
        send: (_alert, _key, delivery): Promise<void> => {
          phases.push(delivery.phase);
          return Promise.resolve();
        },
      });
      yield* Effect.tryPromise(() => deliverAlerts(input));
      yield* Effect.tryPromise(() => deliverAlerts({ ...input, alerts: [], now: 1_010_000 }));
      yield* Effect.tryPromise(() => deliverAlerts({ ...input, now: 1_020_000 }));
      yield* Effect.tryPromise(() => deliverAlerts({ ...input, alerts: [], now: 1_030_000 }));
      expect(phases).toEqual(["firing", "resolved"]);
      yield* Effect.tryPromise(() => deliverAlerts({ ...input, now: 2_800_000 }));
      expect(phases).toEqual(["firing", "resolved", "firing"]);
    })
);
it.effect("refuses a corrupt independent claim without sending or replacing its evidence", () =>
  Effect.gen(function* () {
    const db = yield* database();
    const { bucket } = yield* Effect.tryPromise(() => outageStorage.acquire());
    yield* Effect.tryPromise(() => bucket.put("operational/alerts/d1-v1", "invalid"));
    const send = vi.fn(accepted);
    yield* rejects(deliverAlerts(outageInput(db, bucket, { now: 1_000_000, send })));
    expect(send).not.toHaveBeenCalled();
    const object = yield* Effect.tryPromise(() => bucket.get("operational/alerts/d1-v1"));
    expect(yield* Effect.tryPromise(() => object?.text() ?? Promise.resolve("missing"))).toBe(
      "invalid"
    );
  })
);
it.effect("does not claim or deliver an independent outage after cancellation", () =>
  Effect.gen(function* () {
    const db = yield* database();
    const { bucket } = yield* Effect.tryPromise(() => outageStorage.acquire());
    const send = vi.fn(accepted);
    yield* rejects(
      deliverAlerts({
        ...outageInput(db, bucket, { now: 1_000_000, send }),
        signal: AbortSignal.abort(),
      })
    );
    expect(send).not.toHaveBeenCalled();
    expect(yield* Effect.tryPromise(() => bucket.get("operational/alerts/d1-v1"))).toBeNull();
  })
);

it.effect("a failed independent claim store cannot suppress ordinary D1-backed alerts", () =>
  Effect.gen(function* () {
    const db = yield* database();
    const { bucket } = yield* Effect.tryPromise(() => outageStorage.acquire());
    const unavailableBucket: R2Bucket = {
      ...bucket,
      get: () => Promise.reject(new Error("R2 unavailable")),
    };
    const send = vi.fn((_alert: OperationalAlert) => accepted());
    yield* Effect.tryPromise(() =>
      deliverAlerts({
        ...outageInput(db, unavailableBucket, { now: 1_000_000, send }),
        alerts: [deadLetter],
      })
    );
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toEqual(deadLetter);
  })
);

it.effect("a stalled independent store cannot block ordinary alert delivery", () =>
  Effect.gen(function* () {
    const db = yield* database();
    const { bucket } = yield* Effect.tryPromise(() => outageStorage.acquire());
    const held = Promise.withResolvers<Awaited<ReturnType<R2Bucket["get"]>>>();
    const stalled: R2Bucket = { ...bucket, get: () => held.promise };
    const send = vi.fn((_alert: OperationalAlert) => accepted());
    try {
      yield* Effect.tryPromise(() =>
        deliverAlerts({
          ...outageInput(db, stalled, { now: 1_000_000, send }),
          alerts: [deadLetter],
        })
      );
      expect(send).toHaveBeenCalledOnce();
    } finally {
      held.resolve(null);
    }
  })
);

it.effect("outage timeout aborts the provider request and preserves its retry identity", () =>
  Effect.gen(function* () {
    const db = yield* database();
    const { bucket } = yield* Effect.tryPromise(() => outageStorage.acquire());
    const keys: string[] = [];
    let aborted = false;
    const input = outageInput(db, bucket, {
      now: 1_000_000,
      send: (_alert, key, delivery): Promise<void> => {
        keys.push(key);
        if (keys.length > 1) return Promise.resolve();
        const held = Promise.withResolvers<void>();
        delivery.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            held.reject(new Error("request aborted"));
          },
          { once: true }
        );
        return held.promise;
      },
    });
    yield* rejects(deliverAlerts(input));
    expect(aborted).toBe(true);
    yield* Effect.tryPromise(() => deliverAlerts({ ...input, now: 1_300_000 }));
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  })
);
