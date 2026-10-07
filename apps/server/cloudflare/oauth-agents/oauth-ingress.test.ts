import { CanonicalOperationId } from "../../src/core/canonical-operations/contract";
import { Clock, DateTime, Effect, Exit, Option, Schema } from "effect";
import { deepStrictEqual } from "node:assert";
import { afterEach, expect, it, vi } from "vitest";
import { OAuthCanonicalAdmission } from "../../src/shell/mcp/contract";
import { authenticateOAuth } from "./operations";
import { makeAudit } from "../../src/shell/audit/runtime";
import {
  type Harness,
  TestFailure,
  approvedFixture,
  assertReleased,
  authorizationQuery,
  exchangeFixture,
  mcpFixture,
  reviewedFixture,
  revokeFixtureConsent,
  sendFrom,
  sessionFor,
  sessionForUser,
  setup,
  transactionArguments,
  transactionChildren,
  wait,
} from "./oauth-ingress.test-fixture";

afterEach(() => vi.restoreAllMocks());

const startReview = (
  send: Harness["send"]
): Effect.Effect<string, TestFailure | Schema.SchemaError> =>
  Effect.gen(function* () {
    const query = yield* authorizationQuery(send);
    const started = yield* wait(send(`/oauth/authorize?${query}`));
    expect(started.status).toBe(302);
    return new URL(started.headers.get("location") ?? "").pathname.split("/").at(-1) ?? "";
  });

type HeldBody = Readonly<{
  body: ReadableStream<Uint8Array>;
  reading: Promise<void>;
  release: () => void;
}>;

const heldBody = (): HeldBody => {
  const reading = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const body = new ReadableStream<Uint8Array>(
    {
      pull: (controller): Promise<void> => {
        reading.resolve();
        return release.promise.then(() => controller.close());
      },
    },
    { highWaterMark: 0 }
  );
  return { body, reading: reading.promise, release: release.resolve };
};

it("refuses an otherwise valid code after current Consent withdrawal without consuming or issuing credentials", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      yield* revokeFixtureConsent(fixture.db);
      const refused = yield* wait(exchangeFixture(fixture));
      expect(refused.status).toBe(400);
      expect(yield* wait(refused.json())).toEqual({ error: "invalid_grant" });
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_codes WHERE consumed_at_ms IS NOT NULL")
            .first<number>("count(*)")
        )
      ).toBe(0);
      for (const table of ["oauth_access_credentials", "oauth_refresh_credentials"]) {
        expect(
          yield* wait(fixture.db.prepare(`SELECT count(*) FROM ${table}`).first<number>("count(*)"))
        ).toBe(0);
      }
    })
  ));

const authorityTestInput = (operation: string): Schema.Json => {
  if (operation === "transactions.createTransaction") return transactionArguments;
  if (operation === "operations.executeAtomicBatch") {
    return { payload: { calls: transactionChildren } };
  }
  return {};
};

it.each(
  ["grant", "consent", "credential", "deadline"].flatMap((withdrawn) =>
    [
      "categories.listCategories",
      "memory.recall",
      "dashboard.getDashboard",
      "subscription.getSubscriptionStatus",
      "transactions.createTransaction",
      "operations.executeAtomicBatch",
    ].map((operation) => ({ withdrawn, operation }))
  )
)(
  "rechecks already-admitted OAuth authority after $withdrawn for $operation at the real User coordinator",
  ({ withdrawn, operation }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* approvedFixture({
          scopes: ["read", "write"],
          lifetimeDays: 7,
          auditMigration: true,
        });
        const token = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ access_token: Schema.String })
        )(yield* wait((yield* wait(exchangeFixture(fixture))).json()));
        const admitted = yield* authenticateOAuth({
          db: fixture.db,
          current: yield* Clock.currentTimeMillis,
          request: new Request("https://api.fidyapp.com/mcp", {
            headers: { authorization: `Bearer ${token.access_token}` },
          }),
        });
        expect(Option.isSome(admitted)).toBe(true);
        if (Option.isNone(admitted)) return;
        const caller = admitted.value.subject;
        const payload = yield* Schema.encodeEffect(OAuthCanonicalAdmission)({
          userId: caller.userId,
          connectionId: caller.oauthConnectionId,
          credentialId: caller.credentialId,
          clientId: caller.clientId,
          resource: caller.resource,
          digest: Array.from(caller.digest),
          deadlineMilliseconds:
            (yield* Clock.currentTimeMillis) + (withdrawn === "deadline" ? -1 : 5000),
          operation: CanonicalOperationId.make(operation),
          input: authorityTestInput(operation),
        });
        if (withdrawn === "grant") {
          yield* wait(
            fixture.db
              .prepare("UPDATE oauth_connections SET revoked_at_ms = ? WHERE id = ?")
              .bind(yield* Clock.currentTimeMillis, fixture.connectionId)
              .run()
          );
        }
        if (withdrawn === "consent") {
          yield* revokeFixtureConsent(fixture.db);
        }
        if (withdrawn === "credential") {
          yield* wait(
            fixture.db
              .prepare("UPDATE oauth_access_credentials SET expires_at_ms = issued_at_ms + 1")
              .run()
          );
        }
        const refused = yield* wait(fixture.coordinate(caller.userId, payload));
        const credentialRefusalStatus = withdrawn === "consent" ? 403 : 401;
        expect(refused.status).toBe(withdrawn === "deadline" ? 503 : credentialRefusalStatus);
        const text = yield* wait(refused.text());
        expect(text).not.toContain("Restaurantes");
        expect(text).not.toContain(token.access_token);
        expect(
          yield* wait(
            fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
          )
        ).toBe(0);
        expect(
          yield* wait(
            fixture.db
              .prepare("SELECT count(*) FROM pat_audit WHERE oauth_connection_id = ?")
              .bind(fixture.connectionId)
              .first<number>("count(*)")
          )
        ).toBe(0);
      })
    )
);

it("rolls back approval when required Consent evidence is skipped and code exchange when refresh issuance is skipped", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const review = yield* reviewedFixture();
      yield* wait(
        review.db
          .prepare(
            "CREATE TRIGGER refuse_oauth_consent BEFORE INSERT ON oauth_grant_consents BEGIN SELECT RAISE(IGNORE); END"
          )
          .run()
      );
      expect(
        (yield* wait(
          review.send("/web/oauth/connect", {
            method: "POST",
            headers: review.headers,
            body: review.choice,
          })
        )).status
      ).toBe(503);
      for (const table of [
        "oauth_connections",
        "oauth_grant_consents",
        "oauth_codes",
        "oauth_access_credentials",
        "oauth_refresh_credentials",
      ]) {
        expect(
          yield* wait(review.db.prepare(`SELECT count(*) FROM ${table}`).first<number>("count(*)"))
        ).toBe(0);
      }
      expect(
        yield* wait(
          review.db.prepare("SELECT count(*) FROM oauth_review_requests").first<number>("count(*)")
        )
      ).toBe(1);
      const fixture = yield* approvedFixture();
      yield* wait(
        fixture.db
          .prepare(
            "CREATE TRIGGER refuse_oauth_refresh BEFORE INSERT ON oauth_refresh_credentials BEGIN SELECT RAISE(IGNORE); END"
          )
          .run()
      );
      expect((yield* wait(exchangeFixture(fixture))).status).toBe(400);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_codes WHERE consumed_at_ms IS NOT NULL")
            .first<number>("count(*)")
        )
      ).toBe(0);
      for (const table of ["oauth_access_credentials", "oauth_refresh_credentials"]) {
        expect(
          yield* wait(fixture.db.prepare(`SELECT count(*) FROM ${table}`).first<number>("count(*)"))
        ).toBe(0);
      }
      yield* wait(fixture.db.prepare("DROP TRIGGER refuse_oauth_refresh").run());
      expect((yield* wait(exchangeFixture(fixture))).status).toBe(200);
    })
  ));

it("rejects substituted client, redirect, audience, missing PKCE and expired codes without consuming or minting authority", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      for (const [field, value] of [
        ["client_id", "20000000-0000-4000-8000-000000000001"],
        ["redirect_uri", "http://127.0.0.1:3457/callback"],
        ["resource", "https://evil.example/mcp"],
        ["code_verifier", ""],
      ]) {
        const changed = new URLSearchParams(fixture.body);
        if (value === "") changed.delete(field ?? "");
        else changed.set(field ?? "", value ?? "");
        const rejected = yield* wait(exchangeFixture({ ...fixture, body: changed }));
        expect(rejected.status).toBe(400);
        expect(yield* wait(rejected.json())).toEqual({ error: "invalid_grant" });
      }
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_codes WHERE consumed_at_ms IS NOT NULL")
            .first<number>("count(*)")
        )
      ).toBe(0);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_access_credentials")
            .first<number>("count(*)")
        )
      ).toBe(0);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_refresh_credentials")
            .first<number>("count(*)")
        )
      ).toBe(0);
      yield* wait(
        fixture.db
          .prepare("UPDATE oauth_codes SET expires_at_ms = ?")
          .bind(yield* Clock.currentTimeMillis)
          .run()
      );
      expect((yield* wait(exchangeFixture(fixture))).status).toBe(400);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_access_credentials")
            .first<number>("count(*)")
        )
      ).toBe(0);
    })
  ));

it.each(["abort", "deadline"])(
  "fences subsequent Core units and releases the coordinator after an in-flight Budget query %s",
  (fault) => {
    const abort = new AbortController();
    return Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* approvedFixture({
          scopes: ["read"],
          lifetimeDays: 7,
          auditMigration: true,
        });
        const token = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ access_token: Schema.String })
        )(yield* wait((yield* wait(exchangeFixture(fixture))).json()));
        const time = DateTime.formatIso(yield* DateTime.now);
        yield* wait(
          fixture.db
            .prepare("INSERT INTO budgets VALUES (?, ?, ?, 'COP', '1000', ?, ?)")
            .bind(
              "30000000-0000-4000-8000-000000000001",
              "10000000-0000-4000-8000-000000000001",
              "10000000-0000-4000-8000-000000000001",
              time,
              time
            )
            .run()
        );
        const gate = fixture.holdBudgetRead();
        const response = mcpFixture({
          retryKey: Option.none(),
          send: (path, init) => fixture.send(path, { ...init, signal: abort.signal }),
          bearer: token.access_token,
          method: "tools/call",
          name: "budgets.getBudgetStatus",
          args: { query: { timeZone: "America/Bogota" } },
        });
        yield* wait(gate.waiting);
        if (fault === "abort") {
          abort.abort();
          deepStrictEqual(
            yield* Effect.exit(wait(response)),
            Exit.fail(
              new TestFailure({
                cause: new Error("All fibers interrupted without error"),
              })
            )
          );
        } else {
          yield* wait(response);
        }
        gate.release();
        const next = yield* wait(
          mcpFixture({
            retryKey: Option.none(),
            send: fixture.send,
            bearer: token.access_token,
            method: "tools/call",
            name: "categories.listCategories",
            args: {},
          })
        );
        expect(yield* wait(next.json())).toMatchObject({ result: { isError: false } });
        expect(gate.scheduled().filter((sql) => /budget|transaction_effective/u.test(sql))).toEqual(
          []
        );
      })
    );
  }
);

it("rejects revoked and exactly expired grants before code exchange or query admission", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const revoked = yield* approvedFixture();
      yield* wait(
        revoked.db
          .prepare("UPDATE oauth_connections SET revoked_at_ms = ? WHERE id = ?")
          .bind(yield* Clock.currentTimeMillis, revoked.connectionId)
          .run()
      );
      expect((yield* wait(exchangeFixture(revoked))).status).toBe(400);
      expect(
        yield* wait(
          revoked.db
            .prepare("SELECT count(*) FROM oauth_access_credentials")
            .first<number>("count(*)")
        )
      ).toBe(0);
      const fixture = yield* approvedFixture();
      const token = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ access_token: Schema.String })
      )(yield* wait((yield* wait(exchangeFixture(fixture))).json()));
      const expiration = yield* wait(
        fixture.db
          .prepare("SELECT expires_at_ms FROM oauth_connections WHERE id = ?")
          .bind(fixture.connectionId)
          .first<number>("expires_at_ms")
      );
      expect(expiration).not.toBeNull();
      vi.spyOn(Date, "now").mockReturnValue(expiration ?? 0);
      expect(
        (yield* wait(
          mcpFixture({
            retryKey: Option.none(),
            send: fixture.send,
            bearer: token.access_token,
            method: "tools/call",
            name: "categories.listCategories",
            args: {},
          })
        )).status
      ).toBe(401);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM pat_audit WHERE oauth_connection_id = ?")
            .bind(fixture.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(0);
    })
  ));

it("expires access authority without extending the reviewed connection or disclosing credential material", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const token = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ access_token: Schema.String })
      )(yield* wait((yield* wait(exchangeFixture(fixture))).json()));
      const expiration = yield* wait(
        fixture.db
          .prepare("SELECT expires_at_ms FROM oauth_connections WHERE id = ?")
          .bind(fixture.connectionId)
          .first<number>("expires_at_ms")
      );
      yield* wait(
        fixture.db
          .prepare("UPDATE oauth_access_credentials SET expires_at_ms = issued_at_ms + 1")
          .run()
      );
      const rejected = yield* wait(
        mcpFixture({
          retryKey: Option.none(),
          send: fixture.send,
          bearer: token.access_token,
          method: "tools/call",
          name: "categories.listCategories",
          args: {},
        })
      );
      expect(rejected.status).toBe(401);
      expect(yield* wait(rejected.text())).not.toContain(token.access_token);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT expires_at_ms FROM oauth_connections WHERE id = ?")
            .bind(fixture.connectionId)
            .first<number>("expires_at_ms")
        )
      ).toBe(expiration);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM pat_audit WHERE oauth_connection_id = ?")
            .bind(fixture.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(0);
    })
  ));

it("approves a separately identified connection with atomic Consent and only a protected authorization-code callback", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* setup();
      const requestId = yield* startReview(send);
      const cookie = yield* sessionFor({ db, index: 1 });
      yield* wait(
        db
          .prepare(
            "INSERT INTO onboarding_consent_records VALUES (?, ?, '{}', 'disclosure', 'decision', 1, 1)"
          )
          .bind("10000000-0000-4000-8000-000000000004", "10000000-0000-4000-8000-000000000001")
          .run()
      );
      const headers = {
        origin: "https://app.fidyapp.com",
        cookie,
        "content-type": "application/json",
      };
      const reviewed = yield* wait(send(`/web/oauth/review?requestId=${requestId}`, { headers }));
      const review = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ reviewedAt: Schema.String })
      )(yield* wait(reviewed.json()));
      const reviewedAt = yield* Schema.decodeEffect(Schema.DateTimeUtcFromString)(
        review.reviewedAt
      );
      const expiresAt = DateTime.formatIso(DateTime.add(reviewedAt, { days: 7 }));
      const choice = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
        requestId,
        scopes: ["read"],
        lifetimeDays: 7,
        reviewedAt: review.reviewedAt,
        expiresAt,
      });
      const approved = yield* wait(
        send("/web/oauth/connect", { method: "POST", headers, body: choice })
      );
      expect(approved.status).toBe(200);
      const result = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ callback: Schema.String, connectionId: Schema.String })
      )(yield* wait(approved.json()));
      const callback = new URL(result.callback);
      expect(callback.origin + callback.pathname).toBe("http://127.0.0.1:3456/callback");
      expect(callback.searchParams.get("iss")).toBe("https://api.fidyapp.com");
      expect(callback.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(result).not.toHaveProperty("access_token");
      const tokenBody = new URLSearchParams({
        grant_type: "authorization_code",
        code: callback.searchParams.get("code") ?? "",
        client_id:
          (yield* wait(
            db
              .prepare("SELECT client_id FROM oauth_connections WHERE id = ?")
              .bind(result.connectionId)
              .first<string>("client_id")
          )) ?? "",
        redirect_uri: "http://127.0.0.1:3456/callback",
        resource: "https://api.fidyapp.com/mcp",
        code_verifier: "x".repeat(43),
      });
      const exchange = (): Promise<Response> =>
        send("/oauth/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: tokenBody.toString(),
        });
      expect((yield* wait(exchange())).status).toBe(400);
      expect(
        yield* wait(
          db.prepare("SELECT count(*) FROM oauth_access_credentials").first<number>("count(*)")
        )
      ).toBe(0);
      tokenBody.set("code_verifier", "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
      const exchanges = yield* wait(Promise.all([exchange(), exchange()]));
      expect(exchanges.map((value) => value.status).sort((left, right) => left - right)).toEqual([
        200, 400,
      ]);
      const winner = exchanges.find((value) => value.status === 200);
      if (winner === undefined) return yield* new TestFailure({ cause: "No exchange winner" });
      const token = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          access_token: Schema.String,
          refresh_token: Schema.String,
          expires_in: Schema.Int,
          scope: Schema.String,
        })
      )(yield* wait(winner.json()));
      expect(token.expires_in).toBe(600);
      expect(token.scope).toBe("read");
      expect(token.access_token).not.toBe(token.refresh_token);
      const mcp = (method: string, params?: Schema.Json): Promise<Response> =>
        send("/mcp", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token.access_token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": method,
            ...(method === "tools/call" ? { "mcp-name": "categories.listCategories" } : {}),
          },
          body: Schema.encodeSync(Schema.fromJsonString(Schema.Json))({
            jsonrpc: "2.0",
            id: 1,
            method,
            params: {
              ...Schema.decodeUnknownSync(Schema.JsonObject)(params ?? {}),
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }),
        });
      const listed = yield* wait(mcp("tools/list"));
      expect(listed.status).toBe(200);
      const listBody = yield* wait(listed.text());
      expect(listBody).toContain("categories.listCategories");
      expect(listBody).not.toContain("categories.createKeywordRule");
      const queried = yield* wait(
        mcp("tools/call", { name: "categories.listCategories", arguments: {} })
      );
      const queryBody = yield* wait(queried.text());
      expect(queried.status, queryBody).toBe(200);
      expect(queryBody).toContain("Restaurantes");
      expect(queryBody).toContain('"isError":false');
      expect(queryBody).toContain('"structuredContent"');
      expect(queryBody).not.toContain("createKeywordRule");
      const observed = yield* makeAudit({ database: db }).query({
        userId: "10000000-0000-4000-8000-000000000001",
        limit: 10,
      });
      expect(observed.map((entry) => entry.caller)).toMatchObject([
        { _tag: "OAuthAgent", connectionId: result.connectionId },
      ]);
      expect(
        yield* wait(
          db
            .prepare("SELECT count(*) FROM pat_audit WHERE oauth_connection_id = ?")
            .bind(result.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(1);
      expect((yield* wait(exchange())).status).toBe(400);
      expect(approved.headers.get("cache-control")).toBe("no-store");
      expect(approved.headers.get("referrer-policy")).toBe("no-referrer");
      expect(
        yield* wait(db.prepare("SELECT count(*) FROM oauth_connections").first<number>("count(*)"))
      ).toBe(1);
      expect(
        yield* wait(
          db.prepare("SELECT count(*) FROM oauth_grant_consents").first<number>("count(*)")
        )
      ).toBe(1);
      expect(
        (yield* wait(send("/web/oauth/connect", { method: "POST", headers, body: choice }))).status
      ).toBe(400);
    })
  ));

it(
  "rejects distributed registration and discovery pressure at global limits",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db, send } = yield* setup();
        for (let index = 0; index < 100; index++) {
          expect(
            (yield* wait(
              sendFrom({ send, index: Math.floor(index / 10) })("/oauth/register", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: "{}",
              })
            )).status
          ).toBe(400);
        }
        expect(
          (yield* wait(
            sendFrom({ send, index: 20 })("/oauth/register", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}",
            })
          )).status
        ).toBe(429);
        for (let index = 0; index < 499; index++) {
          expect(
            (yield* wait(
              sendFrom({ send, index: 30 + Math.floor(index / 60) })(
                "/.well-known/oauth-authorization-server"
              )
            )).status
          ).toBe(200);
        }
        expect(
          (yield* wait(sendFrom({ send, index: 50 })("/.well-known/oauth-authorization-server")))
            .status
        ).toBe(429);
        expect(
          yield* wait(
            db.prepare("SELECT count(*) FROM oauth_public_clients").first<number>("count(*)")
          )
        ).toBe(0);
        yield* assertReleased(db);
      })
    ),
  60_000
);

it("keeps the stable User budget across fresh sessions and rotating sources", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* setup();
      const requestId = yield* startReview(send);
      const cookies = [
        yield* sessionFor({ db, index: 1 }),
        yield* sessionForUser({ db, index: 2, userIndex: 1 }),
      ];
      for (let index = 0; index < 60; index++) {
        expect(
          (yield* wait(
            sendFrom({ send, index: index + 1 })(`/web/oauth/review?requestId=${requestId}`, {
              headers: { origin: "https://app.fidyapp.com", cookie: cookies[index % 2] ?? "" },
            })
          )).status
        ).toBe(200);
      }
      expect(
        (yield* wait(
          sendFrom({ send, index: 80 })(`/web/oauth/review?requestId=${requestId}`, {
            headers: { origin: "https://app.fidyapp.com", cookie: cookies[1] ?? "" },
          })
        )).status
      ).toBe(429);
      expect(
        yield* wait(
          db
            .prepare(
              "SELECT count(*) FROM resource_admission_events WHERE policy_key = 'oauth.user.v1'"
            )
            .first<number>("count(*)")
        )
      ).toBe(60);
      yield* assertReleased(db);
    })
  ));

it("atomically caps concurrent pending requests at five per source", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* setup();
      const query = yield* authorizationQuery(send);
      const attempts = yield* wait(
        Promise.all(Array.from({ length: 6 }, () => send(`/oauth/authorize?${query}`)))
      );
      expect(attempts.filter((response) => response.status === 302)).toHaveLength(5);
      expect(attempts.filter((response) => response.status === 503)).toHaveLength(1);
      expect(
        yield* wait(
          db.prepare("SELECT count(*) FROM oauth_review_requests").first<number>("count(*)")
        )
      ).toBe(5);
      yield* assertReleased(db);
    })
  ));

it("atomically caps concurrent request bindings at five per stable User across sources", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* setup();
      const references: Array<string> = [];
      for (let index = 0; index < 6; index++) {
        references.push(yield* startReview(sendFrom({ send, index })));
      }
      const cookie = yield* sessionFor({ db, index: 1 });
      const attempts = yield* wait(
        Promise.all(
          references.map((requestId, index) =>
            sendFrom({ send, index })(`/web/oauth/review?requestId=${requestId}`, {
              headers: { origin: "https://app.fidyapp.com", cookie },
            })
          )
        )
      );
      expect(attempts.filter((response) => response.status === 200)).toHaveLength(5);
      expect(attempts.filter((response) => response.status === 400)).toHaveLength(1);
      expect(
        yield* wait(
          db
            .prepare("SELECT count(*) FROM oauth_review_requests WHERE user_id IS NOT NULL")
            .first<number>("count(*)")
        )
      ).toBe(5);
      yield* assertReleased(db);
    })
  ));

it("refuses registry overflow atomically and reclaims unused registrations without exceeding capacity", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* setup();
      const current = yield* Clock.currentTimeMillis;
      yield* wait(
        db
          .prepare(
            "WITH RECURSIVE clients(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM clients WHERE i < 10000) INSERT INTO oauth_public_clients(id, metadata_json, created_at_ms, last_used_at_ms) SELECT printf('%036d', i), ?, ?, ? FROM clients"
          )
          .bind(
            '{"client_name":"Agente","redirect_uris":["https://example.com/cb"]}',
            current,
            current
          )
          .run()
      );
      const register = (): Promise<Response> =>
        send("/oauth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"client_name":"Agente","redirect_uris":["https://example.com/cb"]}',
        });
      expect((yield* wait(register())).status).toBe(503);
      yield* wait(
        db
          .prepare(
            "UPDATE oauth_public_clients SET last_used_at_ms = ? WHERE id = printf('%036d',1)"
          )
          .bind(current - 2592000000)
          .run()
      );
      const attempts = yield* wait(Promise.all(Array.from({ length: 3 }, register)));
      expect(attempts.filter((response) => response.status === 201)).toHaveLength(1);
      expect(
        yield* wait(
          db.prepare("SELECT count(*) FROM oauth_public_clients").first<number>("count(*)")
        )
      ).toBe(10000);
      expect(
        yield* wait(
          db.prepare("SELECT count(*) FROM oauth_review_requests").first<number>("count(*)")
        )
      ).toBe(0);
      yield* assertReleased(db);
    })
  ));

it("caps outstanding bootstrap work before reading another body and releases leases after rejected payloads", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* setup();
      const probes = Array.from({ length: 32 }, heldBody);
      const attempts = probes.map((probe, index) =>
        sendFrom({ send, index })("/oauth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: probe.body,
          duplex: "half",
        })
      );
      yield* wait(Promise.all(probes.map((probe) => probe.reading)));
      expect(
        (yield* wait(sendFrom({ send, index: 50 })("/.well-known/oauth-authorization-server")))
          .status
      ).toBe(429);
      probes.forEach((probe) => probe.release());
      const rejected = yield* wait(Promise.all(attempts));
      expect(rejected.every((response) => response.status === 400)).toBe(true);
      yield* assertReleased(db);
      expect(
        (yield* wait(sendFrom({ send, index: 50 })("/.well-known/oauth-authorization-server")))
          .status
      ).toBe(200);
    })
  ));

it("requires a fresh same-User session and CSRF-safe origin for review and cancellation without granting unreviewed authority", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* setup();
      const requestId = yield* startReview(send);
      const cookie = yield* sessionFor({ db, index: 1 });
      const otherCookie = yield* sessionFor({ db, index: 2 });
      const path = `/web/oauth/review?requestId=${requestId}`;
      expect((yield* wait(send(path))).status).toBe(403);
      expect(
        (yield* wait(
          send(path, {
            headers: { origin: "https://app.fidyapp.com", cookie: "__Host-fidy_session=forged" },
          })
        )).status
      ).toBe(401);
      const headers = {
        origin: "https://app.fidyapp.com",
        cookie,
        "content-type": "application/json",
      };
      const review = yield* wait(send(path, { headers }));
      expect(review.status).toBe(200);
      expect(yield* wait(review.json())).toMatchObject({
        scopes: ["read"],
        connectAvailable: true,
        permissions: [
          {
            scope: "read",
            label: "Consultar tus datos",
            description: "Consultar tus datos financieros en Fidy.",
          },
        ],
      });
      expect(
        (yield* wait(send(path, { headers: { ...headers, cookie: otherCookie } }))).status
      ).toBe(400);
      const encoded = yield* Schema.encodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            requestId: Schema.String,
            scopes: Schema.Array(Schema.String),
            lifetimeDays: Schema.Finite,
          })
        )
      )({ requestId, scopes: ["write"], lifetimeDays: 90 });
      expect(
        (yield* wait(send("/web/oauth/connect", { method: "POST", headers, body: encoded }))).status
      ).toBe(400);
      const approved = yield* Schema.encodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            requestId: Schema.String,
            scopes: Schema.Array(Schema.String),
            lifetimeDays: Schema.Finite,
          })
        )
      )({ requestId, scopes: ["read"], lifetimeDays: 90 });
      expect(
        (yield* wait(send("/web/oauth/connect", { method: "POST", headers, body: approved })))
          .status
      ).toBe(400);
      const cancelled = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Struct({ requestId: Schema.String }))
      )({ requestId });
      expect(
        (yield* wait(
          send("/web/oauth/cancel", {
            method: "POST",
            headers: { ...headers, origin: "https://evil.example" },
            body: cancelled,
          })
        )).status
      ).toBe(403);
      expect(
        (yield* wait(send("/web/oauth/cancel", { method: "POST", headers, body: cancelled })))
          .status
      ).toBe(200);
      expect((yield* wait(send(path, { headers }))).status).toBe(400);
      expect(
        yield* wait(db.prepare("SELECT count(*) FROM oauth_connections").first<number>("count(*)"))
      ).toBe(0);
    })
  ));

it("rejects hostile registration metadata and actual oversized streamed bytes without retaining a client", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { send, db } = yield* setup();
      for (const body of [
        '{"client_name":"Agente","redirect_uris":["https://example.com/cb"],"client_uri":"http://169.254.169.254/metadata"}',
        '{"client_name":"Agente","redirect_uris":["https://user:secret@example.com/cb"]}',
        '{"client_name":"Agente","redirect_uris":["http://192.168.1.1/cb"]}',
        '{"client_name":"Agente","redirect_uris":["http://localhost/cb"]}',
        '{"client_name":"Agente","redirect_uris":["https://example.com/cb","https://example.com/cb"]}',
        '{"client_name":"Agente","redirect_uris":["https://example.com/cb"],"grant_types":["authorization_code","authorization_code"]}',
        '{"client_name":"Agente","redirect_uris":["https://example.com/cb#fragment"]}',
        '{"client_name":"Agente","redirect_uris":["https://example.com/cb"],"token_endpoint_auth_method":"client_secret_basic"}',
      ]) {
        const rejected = yield* wait(
          send("/oauth/register", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          })
        );
        expect(rejected.status).toBe(400);
        expect(yield* wait(rejected.json())).toEqual({ error: "invalid_client_metadata" });
      }
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull: (controller): void => controller.enqueue(new Uint8Array(16385)),
        cancel: (): void => {
          cancelled = true;
        },
      });
      expect(
        (yield* wait(
          send("/oauth/register", {
            method: "POST",
            headers: { "content-type": "application/json", "content-length": "1" },
            body,
            duplex: "half",
          })
        )).status
      ).toBe(400);
      expect(cancelled).toBe(true);
      expect(
        yield* wait(
          db.prepare("SELECT count(*) FROM oauth_public_clients").first<number>("count(*)")
        )
      ).toBe(0);
    })
  ));

it("bounds registration and discovery pressure independently of canonical allowances", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { send, db } = yield* setup();
      for (let index = 0; index < 10; index++) {
        expect(
          (yield* wait(
            send("/oauth/register", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: '{"client_name":"Agente","redirect_uris":["http://127.0.0.1/cb"]}',
            })
          )).status
        ).toBe(201);
      }
      expect(
        (yield* wait(
          send("/oauth/register", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: '{"client_name":"Agente","redirect_uris":["http://127.0.0.1/cb"]}',
          })
        )).status
      ).toBe(429);
      expect(
        yield* wait(
          db.prepare("SELECT count(*) FROM oauth_public_clients").first<number>("count(*)")
        )
      ).toBe(10);
      for (let index = 0; index < 49; index++) {
        expect((yield* wait(send("/.well-known/oauth-authorization-server"))).status).toBe(200);
      }
      expect((yield* wait(send("/.well-known/oauth-authorization-server"))).status).toBe(429);
    })
  ));

it("refuses expired requests, empty scope choices and arbitrary metadata URLs without leaking claims", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { send, db } = yield* setup();
      const requestId = yield* startReview(send);
      const cookie = yield* sessionFor({ db, index: 1 });
      const headers = {
        origin: "https://app.fidyapp.com",
        cookie,
        "content-type": "application/json",
      };
      const empty = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
        requestId,
        scopes: [],
        lifetimeDays: 90,
      });
      expect(
        (yield* wait(send("/web/oauth/connect", { method: "POST", headers, body: empty }))).status
      ).toBe(400);
      const current = yield* Clock.currentTimeMillis;
      yield* wait(
        db
          .prepare(
            "UPDATE oauth_review_requests SET created_at_ms = ?, expires_at_ms = ? WHERE id = ?"
          )
          .bind(current - 600000, current, requestId)
          .run()
      );
      expect(
        (yield* wait(send(`/web/oauth/review?requestId=${requestId}`, { headers }))).status
      ).toBe(400);
      for (const client of [
        "http://169.254.169.254/metadata",
        "https://127.0.0.1/metadata",
        "https://evil.example/redirect-chain",
      ]) {
        const query = new URLSearchParams({
          client_id: client,
          resource: "https://api.fidyapp.com/mcp",
        });
        const rejected = yield* wait(send(`/oauth/authorize?${query}`));
        expect(rejected.status).toBe(400);
        expect(yield* wait(rejected.text())).toBe('{"error":"invalid_request"}');
      }
      expect((yield* wait(send("/oauth/token", { method: "POST" }))).status).toBe(400);
    })
  ));

it("discovers the fixed MCP resource and issuer through ingress/Core without purchasing canonical work", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { send } = yield* setup();
      const resource = yield* wait(send("/.well-known/oauth-protected-resource/mcp"));
      expect(resource.status).toBe(200);
      expect(yield* wait(resource.json())).toEqual({
        resource: "https://api.fidyapp.com/mcp",
        authorization_servers: ["https://api.fidyapp.com"],
        scopes_supported: ["read"],
        bearer_methods_supported: ["header"],
      });
      const issuer = yield* wait(send("/.well-known/oauth-authorization-server"));
      expect(issuer.status).toBe(200);
      expect(yield* wait(issuer.json())).toMatchObject({
        issuer: "https://api.fidyapp.com",
        authorization_endpoint: "https://api.fidyapp.com/oauth/authorize",
        registration_endpoint: "https://api.fidyapp.com/oauth/register",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
      });
      const challenge = yield* wait(send("/mcp"));
      expect(challenge.status).toBe(401);
      expect(challenge.headers.get("www-authenticate")).toBe(
        'Bearer resource_metadata="https://api.fidyapp.com/.well-known/oauth-protected-resource/mcp", scope="read"'
      );
      expect(resource.headers.get("cache-control")).toBe("no-store");
    })
  ));

it("registers a public client without secrets and binds the redirect, resource and S256 request before browser handoff", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { send, db } = yield* setup();
      const registered = yield* wait(
        send("/oauth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"client_name":"Mi agente","redirect_uris":["http://127.0.0.1/callback"]}',
        })
      );
      expect(registered.status).toBe(201);
      const client = yield* wait(registered.json());
      const parsed = yield* Schema.decodeUnknownEffect(Schema.Struct({ client_id: Schema.String }))(
        client
      );
      expect(client).not.toHaveProperty("client_secret");
      const query = new URLSearchParams({
        client_id: parsed.client_id,
        redirect_uri: "http://127.0.0.1:3456/callback",
        response_type: "code",
        resource: "https://api.fidyapp.com/mcp",
        code_challenge: "A".repeat(43),
        code_challenge_method: "S256",
        state: "state-is-not-authority",
      });
      const started = yield* wait(send(`/oauth/authorize?${query}`));
      expect(started.status).toBe(302);
      expect(started.headers.get("location")).toMatch(
        /^https:\/\/app\.fidyapp\.com\/oauth\/review\/[0-9a-f-]{36}$/u
      );
      const count = yield* wait(
        db.prepare("SELECT count(*) AS total FROM oauth_review_requests").first<number>("total")
      );
      expect(count).toBe(1);
      query.set("resource", "https://evil.example/mcp");
      expect((yield* wait(send(`/oauth/authorize?${query}`))).status).toBe(400);
      query.set("resource", "https://api.fidyapp.com/mcp");
      query.set("redirect_uri", "http://127.0.0.1:3456/other");
      expect((yield* wait(send(`/oauth/authorize?${query}`))).status).toBe(400);
      expect(
        yield* wait(
          db.prepare("SELECT count(*) AS total FROM oauth_review_requests").first<number>("total")
        )
      ).toBe(1);
    })
  ));
