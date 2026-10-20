import { deletionDecision } from "./erasure.test-fixture";
import {
  prepareLocalErasureRegistry,
  resumeErasureCases,
  sweepErasureControlObjects,
} from "./operations";
import { afterAll, expect, it } from "vitest";
import { Clock, Effect, Option, Schema } from "effect";
import {
  installRetentionTestSchema,
  isolatedTestStorage,
  observeRetentionCost,
} from "../d1-test-fixture";
import { ErasureUnavailable } from "../erasure-store/contract";
import { withErasureRecovery } from "./runtime";
import { writePrivateObject } from "../private-objects/operations";
import { generationAssertion } from "./internal/generation";

const storage = isolatedTestStorage();
afterAll(() => storage.dispose());
const userId = "12740000-0000-4000-8000-000000000001";
const generation = "12740000-0000-4000-8000-000000000088";

it("checks the recovery generation without spending writes on guarded reads", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, bucket } = yield* Effect.tryPromise(() => storage.acquire());
      yield* Effect.tryPromise(() => installRetentionTestSchema(db));
      yield* Effect.tryPromise(() => bucket.put("recovery/generation", "initial"));
      const rows = yield* Effect.tryPromise(() =>
        db.batch([
          generationAssertion({ db, generation: "initial" }),
          db.prepare("SELECT generation FROM erasure_generation WHERE id=1"),
        ])
      );
      expect(rows.map((row) => row.meta.rows_written)).toEqual([0, 0]);
      const guarded = withErasureRecovery({
        DB: db,
        ERASURE_REQUIRED: "true",
        ERASURE_BUCKET: bucket,
      }).DB;
      expect(
        yield* Effect.tryPromise(() =>
          guarded
            .prepare("SELECT generation FROM erasure_generation WHERE id=1")
            .first("generation")
        )
      ).toBe("initial");
    })
  ));

it("rolls back an earlier write when a later recovery assertion fails", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Effect.tryPromise(() => storage.acquire());
      yield* Effect.tryPromise(() => installRetentionTestSchema(db));
      expect(
        (yield* Effect.result(
          Effect.tryPromise(() =>
            db.batch([
              db
                .prepare(
                  "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',1)"
                )
                .bind(userId),
              db.prepare("UPDATE erasure_generation SET generation=? WHERE id=1").bind(generation),
              generationAssertion({ db, generation: "initial" }),
            ])
          )
        ))._tag
      ).toBe("Failure");
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM users").first("count")
        )
      ).toBe(0);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT generation FROM erasure_generation WHERE id=1").first("generation")
        )
      ).toBe("initial");
      yield* Effect.tryPromise(() => db.prepare("DELETE FROM erasure_generation WHERE id=1").run());
      expect(
        (yield* Effect.result(
          Effect.tryPromise(() =>
            db.batch([
              generationAssertion({ db, generation: "initial" }),
              db
                .prepare(
                  "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',1)"
                )
                .bind(userId),
            ])
          )
        ))._tag
      ).toBe("Failure");
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM users").first("count")
        )
      ).toBe(0);
    })
  ));

it("fences reads, writes and native Sessions after an interrupted checkpoint or D1 rollback", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, bucket } = yield* Effect.tryPromise(() => storage.acquire());
      yield* Effect.tryPromise(() => installRetentionTestSchema(db));
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',1)"
          )
          .bind(userId)
          .run()
      );
      yield* Effect.tryPromise(() => bucket.put("recovery/generation", "initial"));
      const guarded = withErasureRecovery({
        DB: db,
        ERASURE_REQUIRED: "true",
        ERASURE_BUCKET: bucket,
      }).DB;
      expect(
        yield* Effect.tryPromise(() => guarded.prepare("SELECT id FROM users").first("id"))
      ).toBe(userId);
      yield* Effect.tryPromise(() => bucket.delete("recovery/generation"));
      expect(
        (yield* Effect.result(
          Effect.tryPromise(() => guarded.prepare("SELECT id FROM users").all())
        ))._tag
      ).toBe("Failure");
      expect(yield* Effect.tryPromise(() => bucket.head("recovery/generation"))).toBeNull();
      yield* Effect.tryPromise(() => bucket.put("recovery/generation", generation));
      expect(
        (yield* Effect.result(
          Effect.tryPromise(() => guarded.prepare("SELECT id FROM users").first())
        ))._tag
      ).toBe("Failure");
      expect(
        (yield* Effect.result(
          Effect.tryPromise(() =>
            guarded.prepare("DELETE FROM users WHERE id=?").bind(userId).run()
          )
        ))._tag
      ).toBe("Failure");
      expect(
        (yield* Effect.result(
          Effect.tryPromise(() =>
            guarded.withSession("first-primary").prepare("SELECT id FROM users").first()
          )
        ))._tag
      ).toBe("Failure");
      expect(
        yield* Effect.tryPromise(() => db.prepare("SELECT count(*) FROM users").first("count(*)"))
      ).toBe(1);
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE erasure_generation SET generation=? WHERE id=1").bind(generation).run()
      );
      expect(
        yield* Effect.tryPromise(() => guarded.prepare("SELECT id FROM users").first("id"))
      ).toBe(userId);
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE erasure_generation SET generation='initial' WHERE id=1").run()
      );
      expect(
        (yield* Effect.result(
          Effect.tryPromise(() => guarded.batch([guarded.prepare("SELECT id FROM users")]))
        ))._tag
      ).toBe("Failure");
      const unavailable = withErasureRecovery({ DB: db, ERASURE_REQUIRED: "true" }).DB;
      expect(
        (yield* Effect.result(
          Effect.tryPromise(() => unavailable.prepare("SELECT id FROM users").first())
        ))._tag
      ).toBe("Failure");
    })
  ));

it("purges completed case controls only after both reviewed deadlines, in resumable bounded steps", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, bucket } = yield* Effect.tryPromise(() => storage.acquire());
      yield* Effect.tryPromise(() => installRetentionTestSchema(db));
      const current = yield* Clock.currentTimeMillis;
      const reference = "12740000-0000-4000-8000-000000000002";
      const foreignRef = "12740000-0000-4000-8000-000000000098";
      const foreignUser = "12740000-0000-4000-8000-000000000099";
      const historical = current - 41 * 86400000;
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        deletionDecision({ userId, reference, current: historical })
      );
      const foreignDecision = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        deletionDecision({ userId: foreignUser, reference: foreignRef, current })
      );
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state,decision_json,last_erased_at_ms) VALUES(?,?,?,'Complete',?,?)"
            )
            .bind(reference, userId, historical, encoded, historical),
          db
            .prepare(
              "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state,decision_json,last_erased_at_ms) VALUES(?,?,?,'Complete',?,?)"
            )
            .bind(foreignRef, foreignUser, current, foreignDecision, current),
          db
            .prepare(
              "INSERT INTO erasure_steps(request_id,store_id,data_class,archive_done,delete_done) VALUES(?,'users','identity',1,1)"
            )
            .bind(reference),
        ])
      );
      for (let index = 0; index < 9; index++) {
        yield* Effect.tryPromise(() =>
          bucket.put(`recovery/objects/${reference}/statement/${index}`, "locator")
        );
      }
      yield* Effect.tryPromise(() => bucket.put(`recovery/cases/${reference}`, encoded));
      yield* Effect.tryPromise(() => bucket.put(`recovery/cases/${foreignRef}`, foreignDecision));
      const configuration = {
        db,
        bucket: Option.some(bucket),
        coordinator: {
          getByName: (): Pick<Fetcher, "fetch"> => ({
            fetch: () => Promise.reject(new Error("Completed cases require no User operation")),
          }),
        },
      };
      yield* resumeErasureCases(configuration);
      expect(
        (yield* Effect.tryPromise(() => bucket.list({ prefix: `recovery/objects/${reference}/` })))
          .objects
      ).toHaveLength(1);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) FROM erasure_requests WHERE id=?")
            .bind(reference)
            .first("count(*)")
        )
      ).toBe(1);
      yield* resumeErasureCases(configuration);
      yield* resumeErasureCases(configuration);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) FROM erasure_requests WHERE id=?")
            .bind(reference)
            .first("count(*)")
        )
      ).toBe(0);
      expect(yield* Effect.tryPromise(() => bucket.head(`recovery/cases/${reference}`))).toBeNull();
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) FROM erasure_steps WHERE request_id=?")
            .bind(reference)
            .first("count(*)")
        )
      ).toBe(0);
      expect(
        yield* Effect.tryPromise(() => bucket.head(`recovery/cases/${foreignRef}`))
      ).not.toBeNull();
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) FROM erasure_requests WHERE id=?")
            .bind(foreignRef)
            .first("count(*)")
        )
      ).toBe(1);
    })
  ));

it("reconciles expired orphan control objects without touching financial bytes or live placeholders", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, bucket } = yield* Effect.tryPromise(() => storage.acquire());
      yield* Effect.tryPromise(() => installRetentionTestSchema(db));
      const current = yield* Clock.currentTimeMillis;
      const interrupted = yield* Effect.result(
        writePrivateObject({
          bucket,
          key: "interrupted-upload",
          bytes: new TextEncoder().encode("unpublished financial bytes"),
          metadata: { purpose: "statement-original" },
          digest: Option.none(),
          predecessor: Option.none(),
          authorise: Effect.succeed(false),
        })
      );
      expect(interrupted._tag).toBe("Failure");
      const placeholder = yield* Effect.tryPromise(() => bucket.head("interrupted-upload"));
      expect(Number(placeholder?.customMetadata?.["expiresAtMs"])).toBeGreaterThan(current);
      for (const [key, purpose, expiresAtMs] of [
        ["expired-placeholder", "private-object-placeholder", current - 1],
        ["expired-nonce", "private-object-erased", current - 1],
        ["live-placeholder", "private-object-placeholder", current + 600000],
        ["held-financial", "titular-held-record", current - 1],
      ] as const) {
        yield* Effect.tryPromise(() =>
          bucket.put(key, "untouched", {
            customMetadata: { purpose, expiresAtMs: String(expiresAtMs) },
          })
        );
      }
      yield* sweepErasureControlObjects({
        db,
        buckets: [{ id: "erasure", bucket: Option.some(bucket) }],
      });
      expect(yield* Effect.tryPromise(() => bucket.head("expired-placeholder"))).toBeNull();
      expect(yield* Effect.tryPromise(() => bucket.head("expired-nonce"))).toBeNull();
      expect(yield* Effect.tryPromise(() => bucket.head("live-placeholder"))).not.toBeNull();
      expect(yield* Effect.tryPromise(() => bucket.head("interrupted-upload"))).not.toBeNull();
      expect(
        yield* Effect.tryPromise(() =>
          bucket.get("held-financial").then((object) => object?.text())
        )
      ).toBe("untouched");
    })
  ));

it("preserves a lawful hold published after an expired placeholder was listed", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, bucket } = yield* Effect.tryPromise(() => storage.acquire());
      yield* Effect.tryPromise(() => installRetentionTestSchema(db));
      const current = yield* Clock.currentTimeMillis;
      const key = "racing-held-record";
      yield* Effect.tryPromise(() =>
        bucket.put(key, "expired upload nonce", {
          customMetadata: {
            purpose: "private-object-placeholder",
            expiresAtMs: String(current - 1),
          },
        })
      );
      const list = bucket.list.bind(bucket);
      const racingBucket = new Proxy(bucket, {
        get(target, property): unknown {
          if (property === "list") {
            return (options: R2ListOptions): Promise<R2Objects> =>
              list(options).then((page) =>
                bucket
                  .put(key, "reviewed lawful hold", {
                    customMetadata: {
                      purpose: "titular-held-record",
                      expiresAtMs: String(current + 600000),
                    },
                  })
                  .then(() => page)
              );
          }
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      yield* sweepErasureControlObjects({
        db,
        buckets: [{ id: "erasure", bucket: Option.some(racingBucket) }],
      });
      expect(yield* Effect.tryPromise(() => bucket.get(key).then((object) => object?.text()))).toBe(
        "reviewed lawful hold"
      );
    })
  ));

it("initializes an empty local registry but refuses to recreate a lost approved-case checkpoint", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, bucket } = yield* Effect.tryPromise(() => storage.acquire());
      yield* Effect.tryPromise(() => installRetentionTestSchema(db));
      const io = <A>(run: () => Promise<A>): Effect.Effect<A, ErasureUnavailable> =>
        Effect.tryPromise({ try: run, catch: () => new ErasureUnavailable() });
      const initialize = prepareLocalErasureRegistry({
        query: (statement) => io(() => db.prepare(statement).first()),
        exists: (key) => io(() => bucket.head(key)).pipe(Effect.map((object) => object !== null)),
        empty: io(() => bucket.list({ limit: 1 })).pipe(
          Effect.map((page) => page.objects.length === 0)
        ),
        install: (key, value) =>
          io(() => bucket.put(key, value, { onlyIf: { etagDoesNotMatch: "*" } })).pipe(
            Effect.map((object) => object !== null)
          ),
      });
      yield* initialize;
      expect(
        yield* Effect.tryPromise(() =>
          bucket.get("recovery/generation").then((object) => object?.text())
        )
      ).toBe("initial");
      const previous = yield* Effect.tryPromise(() => bucket.head("recovery/generation"));
      yield* initialize;
      expect((yield* Effect.tryPromise(() => bucket.head("recovery/generation")))?.etag).toBe(
        previous?.etag
      );
      const current = yield* Clock.currentTimeMillis;
      const reference = "12740000-0000-4000-8000-000000000002";
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        deletionDecision({ userId, reference, current })
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state,decision_json) VALUES(?,?,?,'Draining',?)"
          )
          .bind(reference, userId, current, encoded)
          .run()
      );
      yield* Effect.tryPromise(() => bucket.delete("recovery/generation"));
      expect((yield* Effect.result(initialize))._tag).toBe("Failure");
      expect(yield* Effect.tryPromise(() => bucket.head("recovery/generation"))).toBeNull();
    })
  ));

it("avoids empty cursor writes and resumes a multi-page control sweep", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, bucket } = yield* Effect.tryPromise(() => storage.acquire());
      yield* Effect.tryPromise(() => installRetentionTestSchema(db));
      const measured = observeRetentionCost(db);
      const sweep = sweepErasureControlObjects({
        db: measured.database,
        buckets: [{ id: "erasure", bucket: Option.some(bucket) }],
      });
      yield* sweep;
      yield* sweep;
      expect(measured.cost().rowsWritten).toBe(0);
      for (let index = 0; index < 40; index++) {
        yield* Effect.tryPromise(() =>
          bucket.put(`held-${String(index).padStart(2, "0")}`, "held", {
            customMetadata: { purpose: "titular-held-record" },
          })
        );
      }
      yield* sweep;
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT cursor FROM erasure_control_sweeps WHERE bucket='erasure'")
            .first("cursor")
        )
      ).not.toBe("");
      yield* sweep;
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT cursor FROM erasure_control_sweeps WHERE bucket='erasure'")
            .first("cursor")
        )
      ).toBe("");
      expect((yield* Effect.tryPromise(() => bucket.list())).objects).toHaveLength(40);
    })
  ));
