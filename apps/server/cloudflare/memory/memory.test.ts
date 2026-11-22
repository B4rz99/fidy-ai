import { newId } from "../secret-material/operations";
import { NodeFileSystem } from "@effect/platform-node";
import { Clock, Effect, Option, Schema } from "effect";
import { expect, it } from "vitest";
import { Memory, MemoryId, maximumAggregateMemoryTokens } from "../../src/core/memory/contract";
import { ErrorCode } from "../../src/shell/public-http/contract";
import { alice, bob, nativeTransactionJourney, seed } from "../financial-user-store.test-fixture";
import { native as fromTestPromise, nativeBrowserPlatform } from "../user-store.test-fixture";

const users = [alice.user, bob.user] as const,
  sessions = [alice.session, bob.session] as const;

const clock = (): number => Effect.runSync(Clock.currentTimeMillis);

const tick = Effect.sleep("5 millis");

const compareText = (left: string, right: string): number => left.localeCompare(right);

const compareCount = (left: number, right: number): number => left - right;

const cookie = (index: number): string =>
  "__Host-fidy_session=" + (index === 0 ? alice.bearer : bob.bearer);

type Db = Effect.Success<typeof nativeTransactionJourney>;

type Send = Readonly<{ path: string; method: "GET" | "POST" | "PUT" | "DELETE" }> &
  Partial<
    Readonly<{
      payload: object;
      body: string;
      contentType: string;
      session: string;
      bearer: string;
      origin: string;
    }>
  >;

const forwardedHeaders = (input: Send): Headers => {
  const headers = new Headers({ origin: input.origin ?? "https://app.fidyapp.com" });

  if (input.body !== undefined) headers.set("content-type", input.contentType ?? "text/plain");

  if (input.payload !== undefined) headers.set("content-type", "application/json");

  if (input.session !== undefined) {
    headers.set("cookie", input.session);
    headers.set("Fidy-Session-Binding", sessions[input.session === cookie(0) ? 0 : 1]);
  }

  if (input.bearer !== undefined) headers.set("authorization", `Bearer ${input.bearer}`);

  return headers;
};

const forwardedBody = (input: Send): Option.Option<string> =>
  Option.orElse(Option.fromUndefinedOr(input.body), () =>
    Option.map(Option.fromUndefinedOr(input.payload), (payload) => JSON.stringify(payload))
  );

const send = (db: Db, input: Send): Promise<Response> =>
  db.send(
    new Request("https://api.fidyapp.com" + input.path, {
      method: input.method,
      headers: forwardedHeaders(input),
      body: Option.getOrUndefined(forwardedBody(input)),
    })
  );

const Cell = Schema.toCodecJson(Memory);

const Single = Schema.Struct({ data: Cell, next: Schema.Array(Schema.Unknown) });

const Listed = Schema.Struct({ data: Schema.Array(Cell), next: Schema.Array(Schema.Unknown) });

const Forgotten = Schema.Struct({
  data: Schema.toCodecJson(MemoryId),
  next: Schema.Array(Schema.Unknown),
});

const Failure = Schema.Struct({
  error: Schema.Struct({ code: ErrorCode, message: Schema.String }),
  next: Schema.Array(Schema.Unknown),
});

const serialized = (value: unknown): string =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value);

const retainedAggregateBytes = (memories: ReadonlyArray<Memory>): number =>
  new TextEncoder().encode(
    memories.map(({ id, text }) => `{"id":"${id}","text":"${text}"}`).join("\n")
  ).length;

const decode = <A>(schema: Schema.Codec<A, unknown>, response: Response): Effect.Effect<A> =>
  Effect.gen(function* () {
    const body = yield* fromTestPromise(() => response.json());

    return yield* Schema.decodeUnknownEffect(schema)(body).pipe(Effect.orDie);
  });

const remembered = (db: Db, text: string, session: string): Promise<Response> =>
  send(db, { path: "/memories", method: "POST", session, payload: { text } });

const recalled = (db: Db, session: string): Promise<Response> =>
  send(db, { path: "/memories", method: "GET", session });

const memoryTextRows = (db: Db, user: string): ReturnType<Db["exec"]> =>
  db.owner(user).exec("SELECT text FROM memories WHERE user_id=? ORDER BY created_at_ms,id", user);

const auditRows = (db: Db, user: string): ReturnType<Db["exec"]> =>
  db
    .owner(user)
    .exec(
      "SELECT operation,coalesce(refusal_reason,outcome) AS outcome FROM audit_entries WHERE user_id=? AND record_type='session_call' AND operation GLOB 'memory.*' ORDER BY occurred_at_ms,rowid",
      user
    );

it("normalizes formatting, retains current prose, and recalls it in stable creation order", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;

      const created = yield* fromTestPromise(() =>
        remembered(db, "  primera\r\nmemoria  ", cookie(0))
      );

      expect(created.status).toBe(201);
      const first = yield* decode(Single, created);
      expect(first.data.text).toBe("primera\nmemoria");
      expect(first.next).toEqual([]);
      yield* tick;

      const second = yield* decode(
        Single,
        yield* fromTestPromise(() => remembered(db, "segunda memoria", cookie(0)))
      );

      const list = yield* decode(Listed, yield* fromTestPromise(() => recalled(db, cookie(0))));
      expect(list.data.map(({ text }) => text)).toEqual(["primera\nmemoria", "segunda memoria"]);
      expect(list.data.map(({ id }) => id)).toEqual([first.data.id, second.data.id]);
      expect(list.next).toEqual([]);
      expect(yield* fromTestPromise(() => memoryTextRows(db, users[0]))).toEqual([
        { text: "primera\nmemoria" },
        { text: "segunda memoria" },
      ]);
      const noStore = yield* fromTestPromise(() => recalled(db, cookie(0)));
      expect(noStore.headers.get("cache-control")).toBe("no-store");
      const audits = yield* fromTestPromise(() => auditRows(db, users[0]));
      expect(
        audits
          .map(({ operation }) => Schema.decodeUnknownSync(Schema.String)(operation))
          .toSorted(compareText)
      ).toEqual(
        ["memory.recall", "memory.recall", "memory.remember", "memory.remember"].toSorted(
          compareText
        )
      );
      expect(audits.every(({ outcome }) => outcome === "success")).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("replaces stale prose in place and physically removes a forgotten Memory", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;

      const first = yield* decode(
        Single,
        yield* fromTestPromise(() => remembered(db, "texto anterior", cookie(0)))
      );

      yield* tick;

      const second = yield* decode(
        Single,
        yield* fromTestPromise(() => remembered(db, "memoria posterior", cookie(0)))
      );

      const revised = yield* decode(
        Single,
        yield* fromTestPromise(() =>
          send(db, {
            path: `/memories/${first.data.id}`,
            method: "PUT",
            session: cookie(0),
            payload: { text: "texto reemplazado" },
          })
        )
      );

      expect(revised.data.id).toBe(first.data.id);
      expect(revised.data.text).toBe("texto reemplazado");
      expect(revised.data.createdAt).toStrictEqual(first.data.createdAt);
      const list = yield* decode(Listed, yield* fromTestPromise(() => recalled(db, cookie(0))));
      expect(list.data.map(({ id, text }) => ({ id, text }))).toEqual([
        { id: first.data.id, text: "texto reemplazado" },
        { id: second.data.id, text: "memoria posterior" },
      ]);

      const forgotten = yield* decode(
        Forgotten,
        yield* fromTestPromise(() =>
          send(db, { path: `/memories/${first.data.id}`, method: "DELETE", session: cookie(0) })
        )
      );

      expect(forgotten.data).toBe(first.data.id);
      expect(yield* fromTestPromise(() => memoryTextRows(db, users[0]))).toEqual([
        { text: "memoria posterior" },
      ]);

      const remaining = yield* decode(
        Listed,
        yield* fromTestPromise(() => recalled(db, cookie(0)))
      );

      expect(remaining.data.map(({ text }) => text)).toEqual(["memoria posterior"]);

      expect(
        (yield* fromTestPromise(() =>
          send(db, {
            path: `/memories/${first.data.id}`,
            method: "PUT",
            session: cookie(0),
            payload: { text: "no revive" },
          })
        )).status
      ).toBe(404);
      expect(
        (yield* fromTestPromise(() =>
          send(db, { path: `/memories/${first.data.id}`, method: "DELETE", session: cookie(0) })
        )).status
      ).toBe(404);
      expect(yield* fromTestPromise(() => memoryTextRows(db, users[0]))).toEqual([
        { text: "memoria posterior" },
      ]);
      const audits = yield* fromTestPromise(() => auditRows(db, users[0]));
      expect(audits.filter((row) => row.outcome === "not_found")).toEqual([
        expect.objectContaining({ operation: "memory.revise", outcome: "not_found" }),
        expect.objectContaining({ operation: "memory.forget", outcome: "not_found" }),
      ]);
      expect(audits.filter((row) => row.outcome === "success")).toHaveLength(6);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("refuses malformed, empty, and oversized prose without changing Memory state", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const targetText = "estado intacto";
      yield* decode(Single, yield* fromTestPromise(() => remembered(db, targetText, cookie(0))));
      const malformedId = "not-a-memory-id";

      const refusals = yield* Effect.forEach(
        [
          (): Promise<Response> => remembered(db, "   \r\n ", cookie(0)),
          (): Promise<Response> => remembered(db, "x".repeat(2_001), cookie(0)),
          (): Promise<Response> => remembered(db, "x".repeat(20_000), cookie(0)),
          (): Promise<Response> =>
            send(db, {
              path: "/memories",
              method: "POST",
              session: cookie(0),
              body: "prosa sin JSON",
              contentType: "text/plain",
            }),
          (): Promise<Response> =>
            send(db, {
              path: `/memories/${malformedId}`,
              method: "PUT",
              session: cookie(0),
              payload: { text: "texto nuevo" },
            }),
          (): Promise<Response> =>
            send(db, {
              path: `/memories/${malformedId}`,
              method: "DELETE",
              session: cookie(0),
            }),
        ],
        (run) => fromTestPromise(run),
        { concurrency: 2 }
      );

      expect(refusals.map(({ status }) => status)).toEqual([400, 400, 400, 400, 400, 400]);
      const list = yield* decode(Listed, yield* fromTestPromise(() => recalled(db, cookie(0))));
      expect(list.data.map(({ text }) => text)).toEqual([targetText]);
      expect(yield* fromTestPromise(() => memoryTextRows(db, users[0]))).toEqual([
        { text: targetText },
      ]);
      const audits = yield* fromTestPromise(() => auditRows(db, users[0]));
      expect(audits.filter((row) => row.outcome === "validation_failed")).toHaveLength(6);
      expect(audits.filter((row) => row.outcome === "success")).toHaveLength(2);

      const malformed = yield* decode(
        Failure,
        yield* fromTestPromise(() =>
          send(db, {
            path: `/memories/${malformedId}`,
            method: "PUT",
            session: cookie(0),
            payload: { text: "texto nuevo" },
          })
        )
      );

      expect(malformed.error.code).toBe("validation_failed");
      expect(serialized(malformed)).not.toContain(targetText);
      expect(malformed.next).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("rejects aggregate capacity overflow without dropping Memories or echoing prose", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;

      yield* Effect.forEach(
        Array.from({ length: 7 }, (_, index) => index),
        Effect.fnUntraced(function* (index) {
          yield* Effect.sleep("125 millis");

          const response = yield* fromTestPromise(() =>
            remembered(db, `${index}${"x".repeat(1_999)}`, cookie(0))
          );

          expect(response.status).toBe(201);
        }),
        { discard: true }
      );

      const small = yield* decode(
        Single,
        yield* fromTestPromise(() => remembered(db, "pequeña", cookie(0)))
      );

      const canary = `private-capacity-canary-${"y".repeat(1_976)}`;
      const overflowResponse = yield* fromTestPromise(() => remembered(db, canary, cookie(0)));
      const overflow = yield* decode(Failure, overflowResponse);
      expect(overflowResponse.status).toBe(409);
      expect(overflow.error.code).toBe("quota_exhausted");
      expect(serialized(overflow)).not.toContain("private-capacity-canary");
      expect(overflow.next).toEqual([]);

      const revisionCanary = `private-revision-canary-${"z".repeat(1_976)}`;

      const revised = yield* fromTestPromise(() =>
        send(db, {
          path: `/memories/${small.data.id}`,
          method: "PUT",
          session: cookie(0),
          payload: { text: revisionCanary },
        })
      );

      expect(revised.status).toBe(409);
      expect(serialized(yield* decode(Failure, revised))).not.toContain("private-revision-canary");

      const list = yield* decode(Listed, yield* fromTestPromise(() => recalled(db, cookie(0))));
      expect(list.data).toHaveLength(8);
      expect(list.data.some(({ text }) => text === "pequeña")).toBe(true);
      expect(list.data.some(({ text }) => text.includes("canary"))).toBe(false);
      const aggregate = retainedAggregateBytes(list.data);
      expect(aggregate).toBeLessThanOrEqual(maximumAggregateMemoryTokens);
      expect(yield* fromTestPromise(() => auditRows(db, users[0]))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ operation: "memory.remember", outcome: "resource_limit" }),
          expect.objectContaining({ operation: "memory.revise", outcome: "resource_limit" }),
        ])
      );
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("rolls back an earlier batch child when a later Memory write exceeds capacity", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const text = "x".repeat(2_000);

      yield* Effect.forEach(
        Array.from({ length: 6 }, (_, index) => index),
        () => fromTestPromise(() => remembered(db, text, cookie(0))),
        { discard: true }
      );

      const batch = yield* fromTestPromise(() =>
        send(db, {
          path: "/operations/atomic-batch",
          method: "POST",
          session: cookie(0),
          payload: {
            calls: [newId(), newId()].map((callId) => ({
              callId,
              operation: "memory.remember",
              input: { payload: { text } },
            })),
          },
        })
      );

      expect(batch.status).toBe(400);
      expect(
        (yield* decode(
          Schema.Struct({
            error: Schema.Struct({
              code: ErrorCode,
              failedCallIndex: Schema.Int,
              operation: Schema.String,
            }),
          }),
          batch
        )).error
      ).toMatchObject({
        code: "quota_exhausted",
        failedCallIndex: 1,
        operation: "memory.remember",
      });
      expect(yield* fromTestPromise(() => memoryTextRows(db, users[0]))).toHaveLength(6);

      const audits = yield* fromTestPromise(() => auditRows(db, users[0]));

      expect(audits.filter((row) => row.outcome === "success")).toHaveLength(6);
      expect(audits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ operation: "memory.remember", outcome: "resource_limit" }),
        ])
      );
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("bounds concurrent remember calls so one User's aggregate is never oversubscribed", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;

      yield* Effect.forEach(
        Array.from({ length: 6 }, (_, index) => index),
        Effect.fnUntraced(function* (index) {
          expect(
            (yield* fromTestPromise(() =>
              remembered(db, `${index}${"x".repeat(1_999)}`, cookie(0))
            )).status
          ).toBe(201);
        }),
        { discard: true }
      );

      const outcomes = yield* Effect.forEach(
        ["a", "b"],
        (prefix) =>
          fromTestPromise(() =>
            send(db, {
              path: "/memories",
              method: "POST",
              session: cookie(0),
              payload: { text: `${prefix}${"z".repeat(1_999)}` },
            })
          ),
        { concurrency: "unbounded" }
      );

      expect(outcomes.map(({ status }) => status).toSorted(compareCount)).toEqual([201, 409]);
      const list = yield* decode(Listed, yield* fromTestPromise(() => recalled(db, cookie(0))));
      expect(list.data).toHaveLength(7);
      const aggregate = retainedAggregateBytes(list.data);
      expect(aggregate).toBeLessThanOrEqual(maximumAggregateMemoryTokens);
      expect(
        (yield* fromTestPromise(() => auditRows(db, users[0]))).filter(
          (row) => row.operation === "memory.remember" && row.outcome === "resource_limit"
        )
      ).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("enforces the private data API's two-User Memory boundary without partial writes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;

      const owned = yield* decode(
        Single,
        yield* fromTestPromise(() => remembered(db, "memoria privada", cookie(0)))
      );

      expect(
        (yield* decode(Listed, yield* fromTestPromise(() => recalled(db, cookie(1))))).data
      ).toEqual([]);
      expect(
        (yield* fromTestPromise(() =>
          send(db, {
            path: `/memories/${owned.data.id}`,
            method: "PUT",
            session: cookie(1),
            payload: { text: "secuestrada" },
          })
        )).status
      ).toBe(404);
      expect(
        (yield* fromTestPromise(() =>
          send(db, { path: `/memories/${owned.data.id}`, method: "DELETE", session: cookie(1) })
        )).status
      ).toBe(404);
      expect(
        (yield* decode(Listed, yield* fromTestPromise(() => recalled(db, cookie(0))))).data
      ).toEqual([expect.objectContaining({ text: "memoria privada" })]);
      expect(yield* fromTestPromise(() => memoryTextRows(db, users[0]))).toEqual([
        { text: "memoria privada" },
      ]);
      expect(yield* fromTestPromise(() => memoryTextRows(db, users[1]))).toEqual([]);
      expect(yield* fromTestPromise(() => auditRows(db, users[1]))).toEqual([
        expect.objectContaining({ operation: "memory.recall", outcome: "success" }),
        expect.objectContaining({ operation: "memory.revise", outcome: "not_found" }),
        expect.objectContaining({ operation: "memory.forget", outcome: "not_found" }),
      ]);
      expect(yield* fromTestPromise(() => auditRows(db, users[0]))).toEqual([
        expect.objectContaining({ operation: "memory.remember", outcome: "success" }),
        expect.objectContaining({ operation: "memory.recall", outcome: "success" }),
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("stops a revoked WebSession and a withdrawn Consent from reading or writing Memories", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      yield* fromTestPromise(() => remembered(db, "memoria viva", cookie(0)));
      yield* fromTestPromise(() =>
        db.exec("UPDATE web_sessions SET revoked_at_ms = ? WHERE id = ?", clock(), sessions[0])
      );
      expect((yield* fromTestPromise(() => recalled(db, cookie(0)))).status).toBe(401);
      expect(
        (yield* fromTestPromise(() => remembered(db, "después de revocar", cookie(0)))).status
      ).toBe(401);
      expect(
        (yield* fromTestPromise(() =>
          send(db, {
            path: `/memories/${newId()}`,
            method: "DELETE",
            session: cookie(0),
          })
        )).status
      ).toBe(401);
      expect(yield* fromTestPromise(() => memoryTextRows(db, users[0]))).toEqual([
        { text: "memoria viva" },
      ]);
      expect(yield* fromTestPromise(() => auditRows(db, users[0]))).toEqual([
        expect.objectContaining({ operation: "memory.remember", outcome: "success" }),
      ]);

      yield* fromTestPromise(() => remembered(db, "memoria dos", cookie(1)));
      const grantId = "e0000000-0000-4000-8000-000000000063";
      yield* fromTestPromise(() =>
        db
          .owner(bob.user)
          .exec(
            "INSERT INTO consent_history(record_type,id,user_id,occurred_at_ms) VALUES('processing_grant',?,?,?)",
            grantId,
            bob.user,
            clock()
          )
      );
      yield* fromTestPromise(() =>
        db
          .owner(bob.user)
          .exec(
            "INSERT INTO consent_history(record_type,id,user_id,grant_record_id,session_id,occurred_at_ms) VALUES('processing_withdrawal',?,?,?,?,?)",
            newId(),
            bob.user,
            grantId,
            bob.session,
            clock()
          )
      );
      expect((yield* fromTestPromise(() => recalled(db, cookie(1)))).status).toBe(401);
      expect(yield* fromTestPromise(() => memoryTextRows(db, users[1]))).toEqual([
        { text: "memoria dos" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("keeps Memory prose out of emitted telemetry and failed validation responses", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const logs: string[] = [],
        runtime = yield* (yield* nativeBrowserPlatform)(undefined, logs);

      yield* seed(runtime, alice);
      const canary = "private-memory-" + newId();

      const call = (text: string): ReturnType<typeof runtime.dispatchFetch> =>
        runtime.dispatchFetch("https://api.fidyapp.com/memories", {
          method: "POST",
          headers: {
            origin: "https://app.fidyapp.com",
            cookie: cookie(0),
            "Fidy-Session-Binding": alice.session,
            "content-type": "application/json",
          },
          body: JSON.stringify({ text }),
        });

      expect((yield* fromTestPromise(() => call(canary))).status).toBe(201);
      const denied = yield* fromTestPromise(() => call(canary.repeat(100)));
      expect(denied.status).toBe(400);
      expect(yield* fromTestPromise(() => denied.text())).not.toContain(canary);
      expect(logs.some((line) => line.includes("worker.core.fetch"))).toBe(true);
      expect(logs.join("\n")).not.toContain(canary);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("rechecks the bound WebSession deadline for Memory recall", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      expect((yield* fromTestPromise(() => recalled(db, cookie(0)))).status).toBe(200);
      yield* fromTestPromise(() =>
        db.exec(
          "UPDATE web_sessions SET idle_expires_at_ms=created_at_ms+1 WHERE id=?",
          alice.session
        )
      );
      expect((yield* fromTestPromise(() => recalled(db, cookie(0)))).status).toBe(401);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));
