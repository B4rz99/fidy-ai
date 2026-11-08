import { Deferred, Effect, Option, Schema } from "effect";
import { afterAll, expect, it } from "vitest";
import { isolatedTestStorage } from "../d1-test-fixture";
import { ErasureUnavailable } from "../erasure-store/contract";
import { guardedDatabase } from "../erasure/internal/database";
import { makeRecoveryMeasurement } from "../erasure/internal/measurement";
import { makeProtectedExecution } from "./operations";
import { receiveProtectedUnit } from "./runtime";
import { ProtectedReply, ProtectedUnit } from "./contract";

const storage = isolatedTestStorage();
afterAll(() => storage.dispose());
const fixture = (): Promise<
  Readonly<{ db: D1Database; bucket: R2Bucket; binding: Pick<Fetcher, "fetch"> }>
> =>
  storage.acquire().then(({ db, bucket }) =>
    db
      .exec(
        "CREATE TABLE erasure_control(kind TEXT PRIMARY KEY,generation TEXT); INSERT INTO erasure_control VALUES('published','initial'); CREATE TABLE test_values(id INTEGER PRIMARY KEY, value TEXT UNIQUE)"
      )
      .then(() => bucket.put("recovery/generation", "initial"))
      .then(() => ({
        db,
        bucket,
        binding: {
          fetch: (request: RequestInfo | URL) =>
            receiveProtectedUnit({
              request: new Request(request),
              environment: { DB: db, ERASURE_BUCKET: bucket },
            }),
        },
      }))
  );
const guarded = (
  input: Readonly<{ db: D1Database; binding: Pick<Fetcher, "fetch"> }>
): D1Database =>
  guardedDatabase({
    db: input.db,
    bucket: Option.none(),
    measurement: Option.none(),
    execution: Option.some(
      makeProtectedExecution({ binding: input.binding, measurement: Option.none() })
    ),
  });

it("preserves binding snapshots, binary values, empty batches and native recovery refusals", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const input = yield* Effect.tryPromise(fixture);
      const db = guarded(input);
      const bytes = new Uint8Array([8, 9, 10, 11]);
      const statement = db
        .prepare("SELECT hex(?) AS bytes, ? AS flag, ? AS absent")
        .bind(bytes.subarray(1, 3), true, null);
      bytes.fill(0);
      expect(yield* Effect.tryPromise(() => statement.first())).toEqual({
        bytes: "090A",
        flag: 1,
        absent: null,
      });
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT hex(?) AS bytes").bind([1, 2, 255]).first("bytes")
        )
      ).toBe("0102FF");
      expect(yield* Effect.tryPromise(() => db.batch([]))).toEqual([]);
      yield* Effect.tryPromise(() =>
        expect(db.prepare("SELECT 1 AS n").first("missing")).rejects.toBeInstanceOf(
          ErasureUnavailable
        )
      );
      yield* Effect.tryPromise(() =>
        expect(db.prepare("SELECT 1").raw()).rejects.toBeInstanceOf(ErasureUnavailable)
      );
      yield* Effect.tryPromise(() => input.bucket.delete("recovery/generation"));
      yield* Effect.tryPromise(() =>
        expect(statement.first()).rejects.toBeInstanceOf(ErasureUnavailable)
      );
      yield* Effect.tryPromise(() =>
        input.bucket.put("recovery/generation", "00000000-0000-4000-8000-000000000001")
      );
      yield* Effect.tryPromise(() => expect(statement.first()).rejects.toThrow("D1_ERROR"));
    })
  ));

it("rolls back the complete native unit and preserves the owner's trigger refusal", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const input = yield* Effect.tryPromise(fixture);
      const db = guarded(input);
      yield* Effect.tryPromise(() =>
        input.db
          .prepare(
            "CREATE TRIGGER refuse_test BEFORE INSERT ON test_values WHEN NEW.id=2 BEGIN SELECT RAISE(ABORT,'canonical_request_rate'); END"
          )
          .run()
      );
      const refused = db.batch([
        db.prepare("INSERT INTO test_values VALUES(1,'first')"),
        db.prepare("INSERT INTO test_values VALUES(2,'second')"),
      ]);
      const failure: unknown = yield* Effect.tryPromise(() =>
        refused.catch((error: unknown) => error)
      );
      expect(failure).toBeInstanceOf(Error);
      if (failure instanceof Error) {
        expect(failure.cause).toBeInstanceOf(Error);
        if (failure.cause instanceof Error) {
          expect(failure.cause.message).toContain("canonical_request_rate");
        }
      }
      expect(
        yield* Effect.tryPromise(() =>
          input.db.prepare("SELECT count(*) AS n FROM test_values").first("n")
        )
      ).toBe(0);
    })
  ));

it("does not replay an atomic write after its committed response is lost", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const input = yield* Effect.tryPromise(fixture);
      let attempts = 0;
      const db = guarded({
        ...input,
        binding: {
          fetch: (request) => {
            attempts += 1;
            return input.binding.fetch(request).then(() => {
              throw new Error("response lost after commit");
            });
          },
        },
      });
      yield* Effect.tryPromise(() =>
        expect(db.prepare("INSERT INTO test_values VALUES(1,'once')").run()).rejects.toThrow(
          "response lost after commit"
        )
      );
      expect(attempts).toBe(1);
      expect(
        yield* Effect.tryPromise(() =>
          input.db.prepare("SELECT value FROM test_values WHERE id=1").first("value")
        )
      ).toBe("once");
    })
  ));

it("keeps the newest Session bookmark when concurrent replies arrive in reverse order", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const input = yield* Effect.tryPromise(fixture);
      const row = yield* Effect.tryPromise(() => input.db.prepare("SELECT 1 AS n").all());
      const services = yield* Effect.context<never>();
      const pending: Array<
        Readonly<{ unit: ProtectedUnit; finish: (response: Response) => void }>
      > = [];
      const db = guarded({
        ...input,
        binding: {
          fetch: (request) =>
            new Request(request).text().then((body) => {
              const deferred = Deferred.makeUnsafe<Response>();
              pending.push({
                unit: Schema.decodeSync(Schema.fromJsonString(ProtectedUnit))(body),
                finish: (response) => {
                  Deferred.doneUnsafe(deferred, Effect.succeed(response));
                },
              });
              return Effect.runPromiseWith(services)(Deferred.await(deferred));
            }),
        },
      });
      const session = db.withSession("first-primary");
      expect(session.getBookmark()).toBeNull();
      const first = session.prepare("SELECT 1 AS n").all();
      const second = session.prepare("SELECT 1 AS n").all();
      yield* Effect.tryPromise(() => expect.poll(() => pending.length).toBe(2));
      const reply = (bookmark: string): Response =>
        new Response(
          Schema.encodeSync(Schema.fromJsonString(ProtectedReply))({
            outcome: "completed",
            rows: [row],
            bookmark: Option.some(bookmark),
            timing: { r2: 0, d1: 0, generations: 1, batches: 1, sql: Option.none() },
          })
        );
      pending[1]?.finish(reply("0002"));
      yield* Effect.tryPromise(() => second);
      pending[0]?.finish(reply("0001"));
      yield* Effect.tryPromise(() => first);
      expect(session.getBookmark()).toBe("0002");
      const next = session.prepare("SELECT 1 AS n").all();
      yield* Effect.tryPromise(() => expect.poll(() => pending.length).toBe(3));
      expect(pending[2]?.unit.bookmark).toEqual(Option.some("0002"));
      pending[2]?.finish(reply("0002"));
      yield* Effect.tryPromise(() => next);
    })
  ));

it("reports receiver recovery phases alongside the inclusive private roundtrip", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const input = yield* Effect.tryPromise(fixture);
      const measurement = makeRecoveryMeasurement();
      const db = guardedDatabase({
        db: input.db,
        bucket: Option.none(),
        measurement: Option.some(measurement),
        execution: Option.some(
          makeProtectedExecution({ binding: input.binding, measurement: Option.some(measurement) })
        ),
      });
      yield* Effect.tryPromise(() => db.prepare("SELECT 1 AS n").first());
      const response = measurement.respond(new Response());
      expect(response.headers.get("fidy-recovery-batches")).toBe("1");
      expect(response.headers.get("server-timing")).toContain("recovery-r2;dur=");
      expect(response.headers.get("server-timing")).toContain("recovery-d1;dur=");
      expect(response.headers.get("server-timing")).toContain("protected-remote;dur=");
      expect(measurement.snapshot().generations).toBe(1);
    })
  ));

it("refuses malformed private units before any of their statements commit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const input = yield* Effect.tryPromise(fixture);
      const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        commands: [{ sql: "INSERT INTO test_values VALUES(1,'refused')", params: [] }],
        bookmark: 42,
      });
      const response = yield* Effect.tryPromise(() =>
        receiveProtectedUnit({
          request: new Request("https://protected-storage.internal/execute", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          }),
          environment: { DB: input.db, ERASURE_BUCKET: input.bucket },
        })
      );
      expect(response.status).toBe(503);
      expect(
        yield* Effect.tryPromise(() =>
          input.db.prepare("SELECT count(*) AS n FROM test_values").first("n")
        )
      ).toBe(0);
    })
  ));

it("cancels an oversized private reply without returning data or replaying the operation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let cancelled = false;
      let attempts = 0;
      const execute = makeProtectedExecution({
        measurement: Option.none(),
        binding: {
          fetch: () => {
            attempts += 1;
            return Promise.resolve(
              new Response(
                new ReadableStream<Uint8Array>({
                  start(controller): void {
                    controller.enqueue(new Uint8Array(16_777_217));
                  },
                  cancel(): void {
                    cancelled = true;
                  },
                })
              )
            );
          },
        },
      });
      yield* Effect.tryPromise(() =>
        expect(
          execute({ commands: [{ sql: "SELECT 1", params: [] }], bookmark: Option.none() })
        ).rejects.toBeInstanceOf(ErasureUnavailable)
      );
      expect(cancelled).toBe(true);
      expect(attempts).toBe(1);
    })
  ));
