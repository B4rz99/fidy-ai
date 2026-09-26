import { Miniflare } from "miniflare";
import { afterEach, expect, it, vi } from "vitest";
import { Clock, Data, DateTime, Effect, Option, Schema } from "effect";
import { ErrorCode } from "@fidy/server/canonical-runtime";
import { approvedWorkersAiModel } from "@fidy/server/hosted-inference-model";
import { Memory, MemoryId, maximumAggregateMemoryTokens } from "@fidy/server/memory-runtime";
import coreWorker from "../core-worker";
import publicWorker from "../public-worker";
import { UserTransactionCoordinator } from "../transactions/transaction-coordinator";

class TestPromiseFailure extends Data.TaggedError("TestPromiseFailure")<{ cause: unknown }> {}
const fromTestPromise = <A>(promise: () => PromiseLike<A>): Effect.Effect<A> =>
  Effect.tryPromise({
    try: () => Promise.resolve(promise()),
    catch: (cause) => new TestPromiseFailure({ cause }),
  }).pipe(Effect.orDie);
const users = [
  "10000000-0000-4000-8000-000000000071",
  "10000000-0000-4000-8000-000000000072",
] as const;
const sessions = [
  "10000000-0000-4000-8000-000000000081",
  "10000000-0000-4000-8000-000000000082",
] as const;
const pairings = [
  "10000000-0000-4000-8000-000000000091",
  "10000000-0000-4000-8000-000000000092",
] as const;
const dayMilliseconds = 86_400_000;
const compareText = (left: string, right: string): number => left.localeCompare(right);
const compareCount = (left: number, right: number): number => left - right;
let sequence = 0;
const instances: Array<Miniflare> = [];
const clock = (): number => Effect.runSync(Clock.currentTimeMillis);
const iso = (milliseconds: number): string => DateTime.formatIso(DateTime.makeUnsafe(milliseconds));
/** Advances wall-clock ordering so two retained Memories cannot share one created instant. */
const tick = Effect.sleep("5 millis");
const digest = (text: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(text))
    .then((bytes) => new Uint8Array(bytes));
const bearer = (index: number): string => String(index + 1).repeat(43);
let identifierSequence = 0;
/** Deterministic version-4-shaped identifier for client-generated request and path values. */
const identifier = (): string =>
  `20000000-0000-4000-8000-${String((identifierSequence += 1)).padStart(12, "0")}`;
const cookie = (index: number): string => `__Host-fidy_session=${bearer(index)}`;
const applyMigration = (db: D1Database, name: string): Promise<void> =>
  Bun.file(new URL(`../migrations/${name}.sql`, import.meta.url))
    .text()
    .then((sql) =>
      sql
        .replace(/^--.*$/gmu, "")
        .trim()
        .split(/;\s*\n(?=CREATE |ALTER |INSERT |DROP |$)/u)
        .reduce<Promise<void>>(
          (last, statement) => last.then(() => db.prepare(statement).run()).then(() => undefined),
          Promise.resolve()
        )
    );

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

const setup = (): Promise<D1Database> =>
  Effect.runPromise(
    Effect.gen(function* () {
      // Each test owns fresh coordinator instances so no request can reach a disposed database.
      coordinators.clear();
      const mf = new Miniflare({
        workers: [
          {
            config: {
              compatibilityDate: "2026-09-08",
              env: { DB: { id: `memory-${++sequence}`, type: "d1" } },
              manifest: {
                mainModule: "index.mjs",
                modules: {
                  "index.mjs": {
                    contents: "export default {fetch(){return new Response('ok')}}",
                    type: "esm",
                  },
                },
              },
              name: `memory-${sequence}`,
              type: "worker",
            },
          },
        ],
      });
      instances.push(mf);
      yield* fromTestPromise(() => mf.ready);
      const db = yield* fromTestPromise(() => mf.getD1Database("DB"));
      yield* fromTestPromise(() =>
        [
          "0001_categories",
          "0002_resource_admission",
          "0003_pending_consent",
          "0004_onboarding_email",
          "0005_verified_onboarding",
          "0006_browser_login",
          "0007_browser_pairing_email",
          "0008_support_recovery",
          "0009_email_replacement",
          "0009_transactions",
          "0010_pat_lifecycle",
          "0011_transaction_corrections",
          "0012_statement_staging",
          "0012_transaction_search",
          "0013_category_keyword_rules",
          "0014_memory",
          "0015_statement_submission",
        ].reduce<Promise<void>>(
          (previous, name) => previous.then(() => applyMigration(db, name)),
          Promise.resolve()
        )
      );
      const current = clock();
      yield* Effect.forEach(
        users,
        (user, index) =>
          Effect.gen(function* () {
            const verifier = yield* fromTestPromise(() => digest(`verifier${index}`));
            const sessionDigest = yield* fromTestPromise(() => digest(bearer(index)));
            yield* fromTestPromise(() =>
              db
                .prepare(
                  "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)"
                )
                .bind(user, current)
                .run()
            );
            yield* fromTestPromise(() =>
              db
                .prepare(
                  "INSERT INTO browser_login_pairings (id, public_code, verifier_digest, user_id, state, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, 'consumed', ?, ?)"
                )
                .bind(
                  pairings[index],
                  `BCDF-GHJ${index}`,
                  verifier,
                  user,
                  current - 1_000,
                  current + 599_000
                )
                .run()
            );
            yield* fromTestPromise(() =>
              db
                .prepare(
                  "INSERT INTO web_sessions (id, pairing_id, user_id, token_digest, created_at_ms, fresh_until_ms, idle_expires_at_ms, hard_expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
                )
                .bind(
                  sessions[index],
                  pairings[index],
                  user,
                  sessionDigest,
                  current,
                  current + 600_000,
                  current + 3_600_000,
                  current + 7_776_000_000
                )
                .run()
            );
          }),
        { concurrency: "unbounded" }
      );
      return db;
    })
  );

const coordinators = new Map<string, UserTransactionCoordinator>();
const coordinationEnvironment = (db: D1Database): Parameters<typeof coreWorker.fetch>[1] => ({
  DB: db,
  AI: { run: (): Promise<never> => Promise.reject(new Error("unused")) },
  CONTRACT_DIGEST: "a".repeat(64),
  RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
  HOSTED_AI_MODEL: approvedWorkersAiModel,
  BROWSER_ORIGIN: "https://app.fidyapp.com",
  WOMPI_ENVIRONMENT: "",
  WOMPI_PUBLIC_KEY: "",
  WOMPI_PRIVATE_KEY: "",
  WOMPI_INTEGRITY_SECRET: "",
  KAPSO_API_KEY: "",
  KAPSO_WEBHOOK_SECRET: "",
  WHATSAPP_BUSINESS_PORTFOLIO_ID: "portfolio",
  CLOUDFLARE_ACCESS_ISSUER: "",
  CLOUDFLARE_ACCESS_AUDIENCE: "",
  USER_TRANSACTION_COORDINATOR: {
    getByName: (name: string): Pick<Fetcher, "fetch"> => {
      let coordinator = coordinators.get(name);
      if (coordinator === undefined) {
        coordinator = new UserTransactionCoordinator(
          { id: { name } },
          {
            DB: db,
            STATEMENT_STAGING_BUCKET: Option.none(),
            AI: { run: (): Promise<never> => Promise.reject(new Error("unused")) },
            HOSTED_AI_MODEL: approvedWorkersAiModel,
          }
        );
        coordinators.set(name, coordinator);
      }
      return { fetch: (input) => coordinator.fetch(new Request(input)) };
    },
  },
});

const forwardedHeaders = (input: Send): Headers => {
  const headers = new Headers({ origin: input.origin ?? "https://app.fidyapp.com" });
  if (input.body !== undefined) headers.set("content-type", input.contentType ?? "text/plain");
  if (input.payload !== undefined) headers.set("content-type", "application/json");
  if (input.session !== undefined) headers.set("cookie", input.session);
  if (input.bearer !== undefined) headers.set("authorization", `Bearer ${input.bearer}`);
  return headers;
};
const forwardedBody = (input: Send): Option.Option<string> =>
  Option.orElse(Option.fromUndefinedOr(input.body), () =>
    Option.map(Option.fromUndefinedOr(input.payload), (payload) => JSON.stringify(payload))
  );
const send = (db: D1Database, input: Send): Promise<Response> =>
  publicWorker.fetch(
    new Request(`https://api.fidyapp.com${input.path}`, {
      method: input.method,
      headers: forwardedHeaders(input),
      body: Option.getOrUndefined(forwardedBody(input)),
    }),
    {
      BROWSER_ORIGIN: "https://app.fidyapp.com",
      LOCAL_CANONICAL_READ_BEARER: "",
      PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
      RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
      CORE: {
        fetch: (incoming) => coreWorker.fetch(new Request(incoming), coordinationEnvironment(db)),
      },
    }
  );

const issuedPAT = Schema.Struct({
  pat: Schema.Struct({ shortId: Schema.String }),
  bearer: Schema.String,
});
type IssuedPAT = typeof issuedPAT.Type;
const issuePAT = (
  db: D1Database,
  session: string,
  scopes: ReadonlyArray<string>
): Promise<IssuedPAT> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const response = yield* fromTestPromise(() =>
        send(db, {
          path: "/pats",
          method: "POST",
          session,
          payload: {
            requestId: identifier(),
            grant: {
              recipientLabel: "Agent",
              scopes,
              lifetimeDays: 7,
              reviewExpiresAt: iso(clock() + 7 * dayMilliseconds),
            },
          },
        })
      );
      expect(response.status).toBe(200);
      const issued = yield* Schema.decodeUnknownEffect(Schema.Struct({ data: issuedPAT }))(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);
      return issued.data;
    })
  );

/** Canonical Memory decoded through its own published JSON codec at the public seam. */
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
/** Serializes an already-decoded value with the canonical JSON codec for containment assertions. */
const serialized = (value: unknown): string =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value);
/**
 * Independent restatement of the retained-capacity metric: the UTF-8 byte length of the LF-joined
 * `{id,text}` JSON projections the Memory owner bounds. Written from that specification rather than
 * by calling the production projection it is meant to check.
 */
const retainedAggregateBytes = (memories: ReadonlyArray<Memory>): number =>
  new TextEncoder().encode(
    memories.map(({ id, text }) => `{"id":"${id}","text":"${text}"}`).join("\n")
  ).length;
const decode = <A>(schema: Schema.Codec<A, unknown>, response: Response): Effect.Effect<A> =>
  Effect.gen(function* () {
    const body = yield* fromTestPromise(() => response.json());
    return yield* Schema.decodeUnknownEffect(schema)(body).pipe(Effect.orDie);
  });
const remembered = (db: D1Database, text: string, session: string): Promise<Response> =>
  send(db, { path: "/memories", method: "POST", session, payload: { text } });
const recalled = (db: D1Database, session: string): Promise<Response> =>
  send(db, { path: "/memories", method: "GET", session });
const memoryTextRows = (db: D1Database, user: string): Promise<Array<{ text: string }>> =>
  fromTestPromise(() =>
    db
      .prepare("SELECT text FROM memories WHERE user_id = ? ORDER BY created_at, id")
      .bind(user)
      .all<{ text: string }>()
  ).pipe(
    Effect.map((result) => result.results),
    Effect.runPromise
  );
type AuditRow = Readonly<{
  operation: string;
  outcome: string;
  session_id: string;
  occurred_at_ms: number;
}>;
const auditRows = (db: D1Database, user: string): Promise<ReadonlyArray<AuditRow>> =>
  fromTestPromise(() =>
    db
      .prepare(
        "SELECT operation, outcome, session_id, occurred_at_ms FROM memory_audit WHERE user_id = ? ORDER BY occurred_at_ms"
      )
      .bind(user)
      .all<AuditRow>()
  ).pipe(
    Effect.map((result) => result.results),
    Effect.runPromise
  );

afterEach(() =>
  Effect.runPromise(
    fromTestPromise(() => Promise.all(instances.splice(0).map((mf) => mf.dispose())))
  )
);

it("normalizes formatting, retains current prose, and recalls it in stable creation order", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
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
      expect(audits.map(({ operation }) => operation).toSorted(compareText)).toEqual(
        ["memory.recall", "memory.recall", "memory.remember", "memory.remember"].toSorted(
          compareText
        )
      );
      expect(audits.every(({ outcome }) => outcome === "success")).toBe(true);
    })
  ));

it("replaces stale prose in place and physically removes a forgotten Memory", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
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
    })
  ));

it("refuses malformed, empty, and oversized prose without changing Memory state", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
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
        { concurrency: "unbounded" }
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
      // Absence and malformed identity stay indistinguishable to the caller.
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
    })
  ));

it("rejects aggregate capacity overflow without dropping Memories or echoing prose", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      for (let index = 0; index < 7; index += 1) {
        const response = yield* fromTestPromise(() =>
          remembered(db, `${index}${"x".repeat(1_999)}`, cookie(0))
        );
        expect(response.status).toBe(201);
      }
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
    })
  ));

it("bounds concurrent remember calls so one User's aggregate is never oversubscribed", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      for (let index = 0; index < 6; index += 1) {
        expect(
          (yield* fromTestPromise(() => remembered(db, `${index}${"x".repeat(1_999)}`, cookie(0))))
            .status
        ).toBe(201);
      }
      const outcomes = yield* Effect.forEach(
        ["a", "b"],
        (prefix) =>
          fromTestPromise(() => remembered(db, `${prefix}${"z".repeat(1_999)}`, cookie(0))),
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
    })
  ));

it("keeps one User's Memories invisible and unalterable to another User", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
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
      ]);
    })
  ));

it("requires the declared PAT scope, lifetime, revocation standing, and Consent on every Memory call", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const reader = yield* fromTestPromise(() => issuePAT(db, cookie(0), ["read"]));
      const writer = yield* fromTestPromise(() => issuePAT(db, cookie(0), ["write"]));

      const created = yield* fromTestPromise(() =>
        send(db, {
          path: "/memories",
          method: "POST",
          bearer: writer.bearer,
          payload: { text: "pat" },
        })
      );
      expect(created.status).toBe(201);
      expect(
        (yield* fromTestPromise(() =>
          send(db, { path: "/memories", method: "GET", bearer: reader.bearer })
        )).status
      ).toBe(200);
      expect(
        (yield* fromTestPromise(() =>
          send(db, { path: "/memories", method: "GET", bearer: writer.bearer })
        )).status
      ).toBe(403);
      const underScoped = yield* fromTestPromise(() =>
        send(db, {
          path: "/memories",
          method: "POST",
          bearer: reader.bearer,
          payload: { text: "fuera de alcance" },
        })
      );
      expect(underScoped.status).toBe(403);
      expect((yield* decode(Failure, underScoped)).error.code).toBe("scope_missing");
      expect(
        (yield* fromTestPromise(() =>
          send(db, {
            path: `/memories/${identifier()}`,
            method: "DELETE",
            bearer: reader.bearer,
          })
        )).status
      ).toBe(403);
      expect(yield* fromTestPromise(() => memoryTextRows(db, users[0]))).toEqual([{ text: "pat" }]);

      const listed = yield* decode(
        Listed,
        yield* fromTestPromise(() =>
          send(db, { path: "/memories", method: "GET", bearer: reader.bearer })
        )
      );
      expect(listed.data.map(({ text }) => text)).toEqual(["pat"]);
      const patAudit = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT operation, outcome FROM pat_audit WHERE user_id = ? AND operation LIKE 'memory.%'"
          )
          .bind(users[0])
          .all<{ operation: string; outcome: string }>()
      );
      expect(patAudit.results.map(({ operation }) => operation).toSorted(compareText)).toEqual(
        ["memory.remember", "memory.recall", "memory.recall"].toSorted(compareText)
      );
      expect(patAudit.results.every(({ outcome }) => outcome === "accepted")).toBe(true);
      const used = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT COUNT(*) AS used FROM pats WHERE short_id = ? AND last_used_at_ms IS NOT NULL"
          )
          .bind(reader.pat.shortId)
          .first<{ used: number }>()
      );
      expect(used?.used).toBe(1);

      yield* fromTestPromise(() =>
        db
          .prepare("UPDATE pats SET expires_at_ms = ? WHERE short_id = ?")
          .bind(clock() - 1, reader.pat.shortId)
          .run()
      );
      expect(
        (yield* fromTestPromise(() =>
          send(db, { path: "/memories", method: "GET", bearer: reader.bearer })
        )).status
      ).toBe(401);
      yield* fromTestPromise(() =>
        db
          .prepare("UPDATE pats SET expires_at_ms = ?, revoked_at_ms = ? WHERE short_id = ?")
          .bind(clock() + dayMilliseconds, clock(), reader.pat.shortId)
          .run()
      );
      expect(
        (yield* fromTestPromise(() =>
          send(db, { path: "/memories", method: "GET", bearer: reader.bearer })
        )).status
      ).toBe(401);

      // Consent withdrawal blocks protected Memory work for the still-live writer grant.
      const grantId = "e0000000-0000-4000-8000-000000000061";
      yield* fromTestPromise(() =>
        db
          .prepare(
            `INSERT INTO onboarding_consent_records
              (id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms)
              VALUES (?,?,'{}','disclosure','decision',?,?)`
          )
          .bind(grantId, users[0], clock(), clock())
          .run()
      );
      yield* fromTestPromise(() =>
        db
          .prepare(
            `INSERT INTO consent_user_revocations (id,user_id,grant_record_id,session_id,occurred_at_ms)
              VALUES (?,?,?,?,?)`
          )
          .bind("e0000000-0000-4000-8000-000000000062", users[0], grantId, sessions[0], clock())
          .run()
      );
      const withdrawn = yield* fromTestPromise(() =>
        send(db, {
          path: "/memories",
          method: "POST",
          bearer: writer.bearer,
          payload: { text: "después de revocar" },
        })
      );
      expect(withdrawn.status).toBe(403);
      expect((yield* decode(Failure, withdrawn)).error.code).toBe("user_action_required");
      expect(yield* fromTestPromise(() => memoryTextRows(db, users[0]))).toEqual([{ text: "pat" }]);
    })
  ));

it("stops a revoked WebSession and a withdrawn Consent from reading or writing Memories", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      yield* fromTestPromise(() => remembered(db, "memoria viva", cookie(0)));
      yield* fromTestPromise(() =>
        db
          .prepare("UPDATE web_sessions SET revoked_at_ms = ? WHERE id = ?")
          .bind(clock(), sessions[0])
          .run()
      );
      expect((yield* fromTestPromise(() => recalled(db, cookie(0)))).status).toBe(401);
      expect(
        (yield* fromTestPromise(() => remembered(db, "después de revocar", cookie(0)))).status
      ).toBe(401);
      expect(
        (yield* fromTestPromise(() =>
          send(db, {
            path: `/memories/${identifier()}`,
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

      // A live session with withdrawn Consent is refused before any protected Memory work: the
      // ingress session resolver stops resolving such a session platform-wide, exactly as it does
      // for Transactions, so a browser caller is answered as unauthenticated rather than by name.
      yield* fromTestPromise(() => remembered(db, "memoria dos", cookie(1)));
      const grantId = "e0000000-0000-4000-8000-000000000063";
      yield* fromTestPromise(() =>
        db
          .prepare(
            `INSERT INTO onboarding_consent_records
              (id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms)
              VALUES (?,?,'{}','disclosure','decision',?,?)`
          )
          .bind(grantId, users[1], clock(), clock())
          .run()
      );
      yield* fromTestPromise(() =>
        db
          .prepare(
            `INSERT INTO consent_user_revocations (id,user_id,grant_record_id,session_id,occurred_at_ms)
              VALUES (?,?,?,?,?)`
          )
          .bind("e0000000-0000-4000-8000-000000000064", users[1], grantId, sessions[1], clock())
          .run()
      );
      expect((yield* fromTestPromise(() => recalled(db, cookie(1)))).status).toBe(401);
      expect(yield* fromTestPromise(() => memoryTextRows(db, users[1]))).toEqual([
        { text: "memoria dos" },
      ]);
    })
  ));

it("shares the stable-User canonical work budget including Memory audit rows", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const current = clock();
      yield* fromTestPromise(() =>
        db
          .prepare(
            `WITH RECURSIVE sequence(value) AS (
              SELECT 0 UNION ALL SELECT value + 1 FROM sequence WHERE value < 255
            )
            INSERT INTO memory_audit (id, user_id, session_id, operation, outcome, occurred_at_ms)
            SELECT printf('20000000-0000-4000-8000-%012d', value), ?, ?, 'memory.recall', 'success', ?
            FROM sequence`
          )
          .bind(users[0], sessions[0], current)
          .run()
      );
      const limited = yield* fromTestPromise(() => recalled(db, cookie(0)));
      expect(limited.status).toBe(429);
      expect(serialized(yield* decode(Failure, limited))).not.toContain("memoria");
      expect(
        (yield* fromTestPromise(() => remembered(db, "sin presupuesto", cookie(0)))).status
      ).toBe(429);
      expect(
        (yield* fromTestPromise(() =>
          send(db, { path: "/memories", method: "GET", session: cookie(1) })
        )).status
      ).toBe(200);
    })
  ));

it("keeps retained prose out of logs and bounded telemetry records", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* fromTestPromise(() => setup());
      const canary = `telemetry-canary-${identifier()}`;
      const described = (argument: unknown): string =>
        typeof argument === "string" ? argument : serialized(argument);
      const captured: Array<string> = [];
      const channels = ["log", "info", "warn", "error"] as const;
      const spies = channels.map((channel) =>
        vi.spyOn(console, channel).mockImplementation((...args: ReadonlyArray<unknown>) => {
          captured.push(args.map(described).join(" "));
        })
      );
      try {
        expect((yield* fromTestPromise(() => remembered(db, canary, cookie(0)))).status).toBe(201);
        expect((yield* fromTestPromise(() => recalled(db, cookie(0)))).status).toBe(200);
        expect(
          (yield* fromTestPromise(() => remembered(db, canary.repeat(100), cookie(0)))).status
        ).toBe(400);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      // The captured records are the Worker's own telemetry, so containment is not vacuous.
      expect(captured.some((line) => line.includes("worker.core.fetch"))).toBe(true);
      expect(captured.some((line) => line.includes(canary))).toBe(false);
    })
  ));
