import { executeOAuthCanonicalWork } from "../canonical-operations/operations";
import { Clock, DateTime, Effect, Exit, Fiber, Option, Schema } from "effect";
import { deepStrictEqual } from "node:assert";
import { afterEach, expect, it, vi } from "vitest";
import { OAuthCanonicalAdmission } from "../../src/shell/mcp/contract";
import { authenticateOAuth, executeOAuthRefresh } from "./operations";
import { OAuthRefreshAdmission } from "./contract";
import { handleMcpRequest } from "../mcp/runtime";
import { handleOAuthRequest } from "./runtime";
import { OAuthReviewChoice } from "../../src/shell/oauth-agents/contract";
import { makeAudit } from "../../src/shell/audit/runtime";
import {
  ListedTools,
  TestFailure,
  TokenFixture,
  approveAgain,
  approvedFixture,
  assertReleased,
  clockAt,
  exchangeFixture,
  mcpFixture,
  refreshFixture,
  reviewedFixture,
  revokeFixtureConsent,
  sendFrom,
  sessionFor,
  setup,
  wait,
} from "./oauth-ingress.test-fixture";

afterEach(() => vi.restoreAllMocks());

it("reconnects an expired access credential with rotated authority for the same User, client and fixed grant", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const expiresAt = yield* wait(
        fixture.db
          .prepare("SELECT expires_at_ms FROM oauth_connections WHERE id = ?")
          .bind(fixture.connectionId)
          .first<number>("expires_at_ms")
      );
      const accessExpiry = yield* wait(
        fixture.db
          .prepare("SELECT expires_at_ms FROM oauth_access_credentials WHERE connection_id = ?")
          .bind(fixture.connectionId)
          .first<number>("expires_at_ms")
      );
      vi.spyOn(Date, "now").mockReturnValue(accessExpiry ?? 0);
      expect(
        (yield* wait(
          mcpFixture({
            retryKey: Option.none(),
            send: fixture.send,
            bearer: original.access_token,
            method: "tools/list",
          })
        )).status
      ).toBe(401);
      const response = yield* wait(
        refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
      );
      expect(response.status).toBe(200);
      const rotated = yield* Schema.decodeUnknownEffect(TokenFixture)(yield* wait(response.json()));
      expect(rotated.scope).toBe("read");
      expect(rotated.expires_in).toBe(600);
      expect(rotated.refresh_token).not.toBe(original.refresh_token);
      expect(rotated.access_token).not.toBe(original.access_token);
      const queried = yield* wait(
        mcpFixture({
          retryKey: Option.none(),
          send: fixture.send,
          bearer: rotated.access_token,
          method: "tools/call",
          name: "categories.listCategories",
          args: {},
        })
      );
      expect(queried.status).toBe(200);
      expect(yield* wait(queried.text())).toContain("Restaurantes");
      const observed = yield* makeAudit({ database: fixture.db }).query({
        userId: "10000000-0000-4000-8000-000000000001",
        limit: 10,
      });
      expect(observed).toHaveLength(1);
      expect(observed[0]?.caller).toMatchObject({
        _tag: "OAuthAgent",
        connectionId: fixture.connectionId,
      });
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT expires_at_ms FROM oauth_connections WHERE id = ?")
            .bind(fixture.connectionId)
            .first<number>("expires_at_ms")
        )
      ).toBe(expiresAt);
      expect(response.headers.get("cache-control")).toBe("no-store");
      yield* assertReleased(fixture.db);
    })
  ));

it("treats lost token delivery as replay, revokes every generation across restart and requires a new browser grant", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const delivered = yield* wait(
        refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
      );
      const winner = yield* Schema.decodeUnknownEffect(TokenFixture)(yield* wait(delivered.json()));
      // The host did not retain this response. There is deliberately no replacement recovery channel.
      fixture.restartCoordinators();
      const replay = yield* wait(
        refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
      );
      expect(replay.status).toBe(400);
      expect(yield* wait(replay.json())).toEqual({ error: "invalid_grant" });
      for (const bearer of [original.access_token, winner.access_token]) {
        expect(
          (yield* wait(
            mcpFixture({
              retryKey: Option.none(),
              send: fixture.send,
              bearer,
              method: "tools/list",
            })
          )).status
        ).toBe(401);
      }
      expect(
        (yield* wait(
          refreshFixture({ ...fixture, refresh: winner.refresh_token, scope: Option.none() })
        )).status
      ).toBe(400);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_revocation_consents WHERE connection_id = ?")
            .bind(fixture.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(1);
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM oauth_refresh_events").first<number>("count(*)")
        )
      ).toBe(1);
      const replacement = yield* approveAgain(fixture);
      expect(replacement.connectionId).not.toBe(fixture.connectionId);
      const reconnected = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture({ ...fixture, body: replacement.body }))).json())
      );
      expect(
        (yield* wait(
          mcpFixture({
            retryKey: Option.none(),
            send: fixture.send,
            bearer: reconnected.access_token,
            method: "tools/list",
          })
        )).status
      ).toBe(200);
      yield* assertReleased(fixture.db);
    })
  ));

it("persists replay revocation even when independent coordinator instances race the same refresh digest", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const row = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ id: Schema.String, user_id: Schema.String })
      )(
        yield* wait(fixture.db.prepare("SELECT id,user_id FROM oauth_refresh_credentials").first())
      );
      const admission = {
        deadlineAtMs: (yield* Clock.currentTimeMillis) + 5000,
        userId: row.user_id,
        connectionId: fixture.connectionId,
        credentialId: row.id,
        digest: Array.from(
          new Uint8Array(
            yield* wait(
              crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(`oauth-refresh:${original.refresh_token}`)
              )
            )
          )
        ),
        clientId: fixture.body.get("client_id") ?? "",
        resource: "https://api.fidyapp.com/mcp",
      };
      const first = fixture.refreshCoordinate(row.user_id, admission);
      fixture.restartCoordinators();
      const responses = yield* wait(
        Promise.all([first, fixture.refreshCoordinate(row.user_id, admission)])
      );
      expect(
        responses.map((response) => response.status).sort((left, right) => left - right)
      ).toEqual([200, 400]);
      const delivered = responses.find((response) => response.status === 200);
      if (delivered === undefined) return yield* new TestFailure({ cause: "No refresh winner" });
      const winner = yield* Schema.decodeUnknownEffect(TokenFixture)(yield* wait(delivered.json()));
      expect(
        (yield* wait(
          mcpFixture({
            retryKey: Option.none(),
            send: fixture.send,
            bearer: winner.access_token,
            method: "tools/list",
          })
        )).status
      ).toBe(401);
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM oauth_refresh_events").first<number>("count(*)")
        )
      ).toBe(1);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_revocation_consents")
            .first<number>("count(*)")
        )
      ).toBe(1);
    })
  ));

it.each(["write", "admin"])(
  "revokes recognized refresh replay before refusing the substituted %s scope",
  (scope) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* approvedFixture();
        const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
          yield* wait((yield* wait(exchangeFixture(fixture))).json())
        );
        const delivered = yield* wait(
          refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
        );
        const winner = yield* Schema.decodeUnknownEffect(TokenFixture)(
          yield* wait(delivered.json())
        );
        expect(
          (yield* wait(
            refreshFixture({
              ...fixture,
              refresh: original.refresh_token,
              scope: Option.some(scope),
            })
          )).status
        ).toBe(400);
        expect(
          (yield* wait(
            mcpFixture({
              retryKey: Option.none(),
              send: fixture.send,
              bearer: winner.access_token,
              method: "tools/list",
            })
          )).status
        ).toBe(401);
        expect(
          yield* wait(
            fixture.db
              .prepare("SELECT count(*) FROM oauth_revocation_consents")
              .first<number>("count(*)")
          )
        ).toBe(1);
      })
    )
);

it("keeps refresh admission bounded to the stable User across rotation, sources and separately approved connections", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const other = yield* approveAgain(fixture);
      const otherToken = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture({ ...fixture, body: other.body }))).json())
      );
      const rotated = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait(
          (yield* wait(
            refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
          )).json()
        )
      );
      const alreadyCharged = yield* wait(
        fixture.db
          .prepare(
            "SELECT count(*) FROM resource_admission_events WHERE policy_key = 'oauth.user.v1'"
          )
          .first<number>("count(*)")
      );
      for (let index = alreadyCharged ?? 0; index < 60; index++) {
        expect(
          (yield* wait(
            refreshFixture({
              ...fixture,
              send: sendFrom({ send: fixture.send, index: index + 1 }),
              refresh: rotated.refresh_token,
              scope: Option.some("write"),
            })
          )).status
        ).toBe(400);
      }
      const before = yield* wait(
        fixture.db
          .prepare(
            "SELECT (SELECT count(*) FROM oauth_access_credentials) AS access_count,(SELECT count(*) FROM oauth_refresh_credentials) AS refresh_count,(SELECT count(*) FROM oauth_refresh_events) AS events,(SELECT count(*) FROM oauth_revocation_consents) AS revocations,(SELECT count(*) FROM oauth_refresh_credentials WHERE consumed_at_ms IS NOT NULL) AS consumed"
          )
          .first()
      );
      for (const refresh of [rotated.refresh_token, otherToken.refresh_token]) {
        const refused = yield* wait(
          refreshFixture({
            ...fixture,
            send: sendFrom({ send: fixture.send, index: 100 }),
            refresh,
            scope: Option.none(),
          })
        );
        expect(refused.status).not.toBe(200);
        expect(yield* wait(refused.text())).not.toContain(refresh);
      }
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT (SELECT count(*) FROM oauth_access_credentials) AS access_count,(SELECT count(*) FROM oauth_refresh_credentials) AS refresh_count,(SELECT count(*) FROM oauth_refresh_events) AS events,(SELECT count(*) FROM oauth_revocation_consents) AS revocations,(SELECT count(*) FROM oauth_refresh_credentials WHERE consumed_at_ms IS NOT NULL) AS consumed"
            )
            .first()
        )
      ).toEqual(before);
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM resource_admission_events WHERE policy_key = 'oauth.user.v1'"
            )
            .first<number>("count(*)")
        )
      ).toBe(60);
      yield* assertReleased(fixture.db);
    })
  ));

it("allows one concurrent refresh winner but the recognized loser revokes its entire family", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const responses = yield* wait(
        Promise.all(
          Array.from({ length: 2 }, () =>
            refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
          )
        )
      );
      expect(
        responses.map((response) => response.status).sort((left, right) => left - right)
      ).toEqual([200, 400]);
      const response = responses.find((value) => value.status === 200);
      if (response === undefined) return yield* new TestFailure({ cause: "No refresh winner" });
      const winner = yield* Schema.decodeUnknownEffect(TokenFixture)(yield* wait(response.json()));
      fixture.restartCoordinators();
      expect(
        (yield* wait(
          mcpFixture({
            retryKey: Option.none(),
            send: fixture.send,
            bearer: winner.access_token,
            method: "tools/list",
          })
        )).status
      ).toBe(401);
      expect(
        (yield* wait(
          refreshFixture({ ...fixture, refresh: winner.refresh_token, scope: Option.none() })
        )).status
      ).toBe(400);
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM oauth_refresh_events").first<number>("count(*)")
        )
      ).toBe(1);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_revocation_consents")
            .first<number>("count(*)")
        )
      ).toBe(1);
      yield* assertReleased(fixture.db);
    })
  ));

it("uses the supplied Clock for OAuth ingress admission, issuance and outstanding lease release", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* setup();
      const current = 1700000000000;
      const clock = clockAt({ live: yield* Clock.Clock, current, read: () => current });
      const response = yield* handleOAuthRequest({
        db: fixture.db,
        browserOrigin: "https://app.fidyapp.com",
        request: new Request("https://api.fidyapp.com/oauth/register", {
          method: "POST",
          headers: { "x-oauth-source": "a".repeat(64), "content-type": "application/json" },
          body: '{"client_name":"Agente","redirect_uris":["http://127.0.0.1/callback"]}',
        }),
        coordinator: {
          getByName: () => ({
            fetch: (): Promise<Response> =>
              Promise.reject(new Error("Registration cannot coordinate User work")),
          }),
        },
      }).pipe(Effect.provideService(Clock.Clock, clock));
      expect(response.status).toBe(201);
      expect(yield* wait(response.json())).toMatchObject({ client_id_issued_at: 1700000000 });
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT admitted_at_epoch_ms,released_at_epoch_ms FROM resource_admission_events WHERE policy_key='oauth.concurrent.v1'"
            )
            .first()
        )
      ).toEqual({ admitted_at_epoch_ms: current, released_at_epoch_ms: current });
    })
  ));

it("clips refresh publication to the supplied Clock without extending absolute authority", () => {
  const signal = new AbortController().signal;
  return Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const row = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ id: Schema.String, user_id: Schema.String })
      )(
        yield* wait(fixture.db.prepare("SELECT id,user_id FROM oauth_refresh_credentials").first())
      );
      const expiry = yield* Schema.decodeUnknownEffect(Schema.Int)(
        yield* wait(
          fixture.db.prepare("SELECT expires_at_ms FROM oauth_connections").first("expires_at_ms")
        )
      );
      const current = expiry - 1000;
      const liveClock = yield* Clock.Clock;
      const clock = clockAt({ live: liveClock, current, read: () => current });
      const admission = yield* Schema.decodeUnknownEffect(OAuthRefreshAdmission)({
        credentialId: row.id,
        userId: row.user_id,
        connectionId: fixture.connectionId,
        clientId: fixture.body.get("client_id"),
        resource: "https://api.fidyapp.com/mcp",
        deadlineAtMs: expiry,
        digest: Array.from(
          new Uint8Array(
            yield* wait(
              crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(`oauth-refresh:${token.refresh_token}`)
              )
            )
          )
        ),
      });
      const response = yield* executeOAuthRefresh({
        db: fixture.db,
        admission,
        signal,
      }).pipe(Effect.provideService(Clock.Clock, clock));
      expect(response.status).toBe(200);
      expect(yield* wait(response.json())).toMatchObject({ expires_in: 1 });
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT occurred_at_ms FROM oauth_refresh_events")
            .first("occurred_at_ms")
        )
      ).toBe(current);
    })
  );
});

it("inherits the supplied Clock through MCP protocol callbacks when bounding canonical admission", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const current = (yield* Clock.currentTimeMillis) + 120000;
      const liveClock = yield* Clock.Clock;
      const clock = clockAt({ live: liveClock, current, read: () => current });
      let deadline = 0;
      const runNative = Effect.runPromiseWith(yield* Effect.context<never>());
      const response = yield* handleMcpRequest({
        db: fixture.db,
        request: new Request("https://api.fidyapp.com/mcp", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token.access_token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": "tools/call",
            "mcp-name": "categories.listCategories",
          },
          body: yield* Schema.encodeEffect(
            Schema.fromJsonString(
              Schema.Struct({
                jsonrpc: Schema.Literal("2.0"),
                id: Schema.Int,
                method: Schema.Literal("tools/call"),
                params: Schema.Struct({
                  name: Schema.Literal("categories.listCategories"),
                  arguments: Schema.Struct({}),
                  _meta: Schema.Struct({
                    "io.modelcontextprotocol/protocolVersion": Schema.Literal("2026-07-28"),
                    "io.modelcontextprotocol/clientCapabilities": Schema.Struct({}),
                  }),
                }),
              })
            )
          )({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "categories.listCategories",
              arguments: {},
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }),
        }),
        coordinator: {
          getByName: (userId) => ({
            fetch: (incoming): Promise<Response> =>
              runNative(
                Effect.gen(function* () {
                  const request = incoming instanceof Request ? incoming : new Request(incoming);
                  const admission = yield* Schema.decodeUnknownEffect(OAuthCanonicalAdmission)(
                    yield* wait(request.json())
                  );
                  deadline = admission.deadlineMilliseconds;
                  const payload = yield* Schema.encodeEffect(OAuthCanonicalAdmission)(admission);
                  return yield* wait(fixture.coordinate(userId, payload));
                })
              ),
          }),
        },
      }).pipe(Effect.provideService(Clock.Clock, clock));
      expect(yield* wait(response.json())).toMatchObject({ result: { isError: false } });
      expect(deadline).toBe(current + 3000);
    })
  ));

it("refuses exact OAuth credential expiry under a supplied Clock without canonical Audit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const request = new Request("https://api.fidyapp.com/mcp", {
        headers: { authorization: `Bearer ${token.access_token}` },
      });
      const caller = yield* authenticateOAuth({
        db: fixture.db,
        request,
        current: yield* Clock.currentTimeMillis,
      });
      if (Option.isNone(caller)) return yield* new TestFailure({ cause: "Missing caller" });
      const current = yield* Schema.decodeUnknownEffect(Schema.Int)(
        yield* wait(
          fixture.db
            .prepare("SELECT expires_at_ms FROM oauth_access_credentials")
            .first("expires_at_ms")
        )
      );
      const liveClock = yield* Clock.Clock;
      const clock = clockAt({ live: liveClock, current, read: () => current });
      const response = yield* executeOAuthCanonicalWork({
        retryKey: Option.none(),
        confirmation: Option.none(),
        bucket: Option.none(),
        inference: Option.none(),
        db: fixture.db,
        subject: caller.value.subject,
        operation: "categories.listCategories",
        input: { unexpected: true },
        signal: request.signal,
        deadlineMilliseconds: current + 3000,
      }).pipe(Effect.provideService(Clock.Clock, clock));
      expect(response.status).toBe(401);
      expect(
        yield* makeAudit({ database: fixture.db }).query({
          userId: caller.value.subject.userId,
          limit: 10,
        })
      ).toEqual([]);
    })
  ));

it("fences later Promise-owned query units at the supplied Clock deadline while settling the started read", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      let current = yield* Clock.currentTimeMillis;
      const request = new Request("https://api.fidyapp.com/mcp", {
        headers: { authorization: `Bearer ${token.access_token}` },
      });
      const caller = yield* authenticateOAuth({ db: fixture.db, request, current });
      if (Option.isNone(caller)) return yield* new TestFailure({ cause: "Missing caller" });
      const time = DateTime.formatIso(DateTime.makeUnsafe(current));
      yield* wait(
        fixture.db
          .prepare("INSERT INTO budgets VALUES (?, ?, ?, 'COP', '1000', ?, ?)")
          .bind(
            "30000000-0000-4000-8000-000000000001",
            caller.value.subject.userId,
            "10000000-0000-4000-8000-000000000001",
            time,
            time
          )
          .run()
      );
      const gate = fixture.holdBudgetRead();
      const deadlineMilliseconds = current + 3000;
      const live = yield* Clock.Clock;
      const clock: Clock.Clock = {
        currentTimeMillisUnsafe: () => current,
        currentTimeMillis: Effect.sync(() => current),
        currentTimeNanosUnsafe: () => BigInt(current) * 1_000_000n,
        currentTimeNanos: Effect.sync(() => BigInt(current) * 1_000_000n),
        monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: live.monotonicTimeNanos,
        sleep: (duration) => live.sleep(duration),
      };
      const running = yield* executeOAuthCanonicalWork({
        retryKey: Option.none(),
        confirmation: Option.none(),
        bucket: Option.none(),
        inference: Option.none(),
        db: fixture.db,
        subject: caller.value.subject,
        operation: "budgets.getBudgetStatus",
        input: { query: { timeZone: "America/Bogota" } },
        signal: request.signal,
        deadlineMilliseconds,
      }).pipe(Effect.provideService(Clock.Clock, clock), Effect.forkChild);
      yield* wait(gate.waiting);
      current = deadlineMilliseconds;
      gate.release();
      expect((yield* Fiber.join(running)).status).toBe(503);
      expect(gate.scheduled()).toEqual([]);
      const audit = yield* makeAudit({ database: fixture.db }).query({
        userId: caller.value.subject.userId,
        limit: 10,
      });
      expect(audit.map(({ operation, outcome }) => ({ operation, outcome }))).toEqual([
        { operation: "budgets.getBudgetStatus", outcome: "succeeded" },
      ]);
    })
  ));

const assertRefreshUnchanged = (
  fixture: Readonly<{ db: D1Database; connectionId: string }>
): Effect.Effect<void, TestFailure> =>
  Effect.gen(function* () {
    expect(
      yield* wait(
        fixture.db
          .prepare(
            "SELECT count(*) FROM oauth_refresh_credentials WHERE consumed_at_ms IS NOT NULL"
          )
          .first<number>("count(*)")
      )
    ).toBe(0);
    for (const table of ["oauth_access_credentials", "oauth_refresh_credentials"]) {
      expect(
        yield* wait(fixture.db.prepare(`SELECT count(*) FROM ${table}`).first<number>("count(*)"))
      ).toBe(1);
    }
    for (const table of ["oauth_refresh_events", "oauth_revocation_consents"]) {
      expect(
        yield* wait(fixture.db.prepare(`SELECT count(*) FROM ${table}`).first<number>("count(*)"))
      ).toBe(0);
    }
  });

it("rejects unknown, wrong-purpose, wrong client/resource and escalated refresh without damaging valid authority", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const base = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: original.refresh_token,
        client_id: fixture.body.get("client_id") ?? "",
        resource: "https://api.fidyapp.com/mcp",
      });
      for (const [field, value] of [
        ["refresh_token", "x".repeat(43)],
        ["refresh_token", original.access_token],
        ["client_id", "20000000-0000-4000-8000-000000000001"],
        ["resource", "https://evil.example/mcp"],
        ["scope", "read write"],
        ["scope", "admin"],
        ["scope", ""],
        ["scope", "read read"],
        ["user_id", "20000000-0000-4000-8000-000000000001"],
      ]) {
        const body = new URLSearchParams(base);
        body.set(field ?? "", value ?? "");
        const refused = yield* wait(exchangeFixture({ ...fixture, body }));
        expect(refused.status).toBe(400);
        expect(yield* wait(refused.json())).toEqual({ error: "invalid_grant" });
        yield* assertRefreshUnchanged(fixture);
      }
      expect(
        (yield* wait(
          mcpFixture({
            retryKey: Option.none(),
            send: fixture.send,
            bearer: original.access_token,
            method: "tools/list",
          })
        )).status
      ).toBe(200);
      expect(
        (yield* wait(
          refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
        )).status
      ).toBe(200);
    })
  ));

it.each(["grant", "consent", "credential"])(
  "refuses refresh after %s withdrawal without consuming or publishing any generation",
  (withdrawn) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* approvedFixture();
        const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
          yield* wait((yield* wait(exchangeFixture(fixture))).json())
        );
        if (withdrawn === "grant") {
          yield* wait(
            fixture.db
              .prepare("UPDATE oauth_connections SET revoked_at_ms = ?")
              .bind(yield* Clock.currentTimeMillis)
              .run()
          );
        }
        if (withdrawn === "consent") yield* revokeFixtureConsent(fixture.db);
        if (withdrawn === "credential") {
          yield* wait(
            fixture.db
              .prepare("UPDATE oauth_refresh_credentials SET expires_at_ms = issued_at_ms + 1")
              .run()
          );
        }
        expect(
          (yield* wait(
            refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
          )).status
        ).toBe(400);
        yield* assertRefreshUnchanged(fixture);
        yield* assertReleased(fixture.db);
      })
    )
);

it("atomically revokes recognized replay after Consent withdrawal without minting replacement credentials", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      expect(
        (yield* wait(
          refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
        )).status
      ).toBe(200);
      yield* revokeFixtureConsent(fixture.db);
      expect(
        (yield* wait(
          refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
        )).status
      ).toBe(400);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_revocation_consents")
            .first<number>("count(*)")
        )
      ).toBe(1);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT revoked_at_ms FROM oauth_connections")
            .first<number>("revoked_at_ms")
        )
      ).not.toBeNull();
      for (const table of ["oauth_access_credentials", "oauth_refresh_credentials"]) {
        expect(
          yield* wait(fixture.db.prepare(`SELECT count(*) FROM ${table}`).first<number>("count(*)"))
        ).toBe(2);
      }
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM oauth_refresh_events").first<number>("count(*)")
        )
      ).toBe(1);
      yield* assertReleased(fixture.db);
    })
  ));

it("rolls back replay revocation if its required Consent evidence cannot be appended", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const winner = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait(
          (yield* wait(
            refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
          )).json()
        )
      );
      yield* wait(
        fixture.db
          .prepare(
            "CREATE TRIGGER skip_replay_evidence BEFORE INSERT ON oauth_revocation_consents BEGIN SELECT RAISE(IGNORE); END"
          )
          .run()
      );
      expect(
        (yield* wait(
          refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
        )).status
      ).toBe(400);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_revocation_consents")
            .first<number>("count(*)")
        )
      ).toBe(0);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT revoked_at_ms FROM oauth_connections")
            .first<number>("revoked_at_ms")
        )
      ).toBeNull();
      expect(
        (yield* wait(
          mcpFixture({
            retryKey: Option.none(),
            send: fixture.send,
            bearer: winner.access_token,
            method: "tools/list",
          })
        )).status
      ).toBe(200);
      yield* wait(fixture.db.prepare("DROP TRIGGER skip_replay_evidence").run());
      expect(
        (yield* wait(
          refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
        )).status
      ).toBe(400);
      expect(
        (yield* wait(
          mcpFixture({
            retryKey: Option.none(),
            send: fixture.send,
            bearer: winner.access_token,
            method: "tools/list",
          })
        )).status
      ).toBe(401);
      yield* assertReleased(fixture.db);
    })
  ));

it("honors the exact refresh inactivity boundary even before the absolute 90-day grant ends", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture({
        scopes: ["read"],
        lifetimeDays: 90,
        auditMigration: true,
      });
      const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const expiry = yield* wait(
        fixture.db
          .prepare("SELECT expires_at_ms FROM oauth_refresh_credentials")
          .first<number>("expires_at_ms")
      );
      const grantExpiry = yield* wait(
        fixture.db
          .prepare("SELECT expires_at_ms FROM oauth_connections")
          .first<number>("expires_at_ms")
      );
      expect((grantExpiry ?? 0) - (expiry ?? 0)).toBeGreaterThan(0);
      vi.spyOn(Date, "now").mockReturnValue(expiry ?? 0);
      expect(
        (yield* wait(
          refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
        )).status
      ).toBe(400);
      yield* assertRefreshUnchanged(fixture);
    })
  ));

it("clips both new credentials to the immutable grant and rejects at its exact expiration", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const expiration = yield* wait(
        fixture.db
          .prepare("SELECT expires_at_ms FROM oauth_connections")
          .first<number>("expires_at_ms")
      );
      const clock = vi.spyOn(Date, "now").mockReturnValue((expiration ?? 0) - 1000);
      const response = yield* wait(
        refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
      );
      expect(response.status).toBe(200);
      const winner = yield* Schema.decodeUnknownEffect(TokenFixture)(yield* wait(response.json()));
      expect(winner.expires_in).toBe(1);
      for (const table of ["oauth_access_credentials", "oauth_refresh_credentials"]) {
        expect(
          yield* wait(
            fixture.db
              .prepare(`SELECT expires_at_ms FROM ${table} ORDER BY issued_at_ms DESC LIMIT 1`)
              .first<number>("expires_at_ms")
          )
        ).toBe(expiration);
      }
      clock.mockReturnValue(expiration ?? 0);
      expect(
        (yield* wait(
          refreshFixture({ ...fixture, refresh: winner.refresh_token, scope: Option.none() })
        )).status
      ).toBe(400);
      expect(
        (yield* wait(
          mcpFixture({
            retryKey: Option.none(),
            send: fixture.send,
            bearer: winner.access_token,
            method: "tools/list",
          })
        )).status
      ).toBe(401);
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM oauth_refresh_events").first<number>("count(*)")
        )
      ).toBe(1);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT revoked_at_ms FROM oauth_connections")
            .first<number>("revoked_at_ms")
        )
      ).toBeNull();
    })
  ));

it.each(["oauth_access_credentials", "oauth_refresh_credentials", "oauth_refresh_events"])(
  "rolls back refresh consumption and all credentials when %s publication is skipped",
  (table) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* approvedFixture();
        const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
          yield* wait((yield* wait(exchangeFixture(fixture))).json())
        );
        yield* wait(
          fixture.db
            .prepare(
              `CREATE TRIGGER skip_refresh_publication BEFORE INSERT ON ${table} BEGIN SELECT RAISE(IGNORE); END`
            )
            .run()
        );
        expect(
          (yield* wait(
            refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
          )).status
        ).toBe(400);
        yield* assertRefreshUnchanged(fixture);
        yield* wait(fixture.db.prepare("DROP TRIGGER skip_refresh_publication").run());
        expect(
          (yield* wait(
            refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
          )).status
        ).toBe(200);
      })
    )
);

it("retains narrowed credential scopes across reconnect and never escalates back to the broader grant", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture({
        scopes: ["read", "write"],
        lifetimeDays: 7,
        auditMigration: true,
      });
      const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const narrowed = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait(
          (yield* wait(
            refreshFixture({
              ...fixture,
              refresh: original.refresh_token,
              scope: Option.some("write"),
            })
          )).json()
        )
      );
      expect(narrowed.scope).toBe("write");
      const listed = yield* wait(
        mcpFixture({
          retryKey: Option.none(),
          send: fixture.send,
          bearer: narrowed.access_token,
          method: "tools/list",
        })
      );
      const narrowedTools = yield* Schema.decodeUnknownEffect(ListedTools)(
        yield* wait(listed.json())
      );
      expect(narrowedTools.result.tools.map(({ name }) => name)).toContain(
        "transactions.createTransaction"
      );
      expect(narrowedTools.result.tools.map(({ name }) => name)).not.toContain(
        "categories.listCategories"
      );
      expect(
        (yield* wait(
          refreshFixture({
            ...fixture,
            refresh: narrowed.refresh_token,
            scope: Option.some("read write"),
          })
        )).status
      ).toBe(400);
      const retained = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait(
          (yield* wait(
            refreshFixture({ ...fixture, refresh: narrowed.refresh_token, scope: Option.none() })
          )).json()
        )
      );
      expect(retained.scope).toBe("write");
    })
  ));

it("rejects cross-User/client/resource refresh admissions under the real User lock without consuming authority", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      yield* sessionFor({ db: fixture.db, index: 2 });
      const row = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ id: Schema.String, user_id: Schema.String })
      )(
        yield* wait(
          fixture.db.prepare("SELECT id,user_id,digest FROM oauth_refresh_credentials").first()
        )
      );
      const admission = {
        deadlineAtMs: (yield* Clock.currentTimeMillis) + 5000,
        userId: row.user_id,
        connectionId: fixture.connectionId,
        credentialId: row.id,
        digest: Array.from(
          new Uint8Array(
            yield* wait(
              crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(`oauth-refresh:${token.refresh_token}`)
              )
            )
          )
        ),
        clientId: fixture.body.get("client_id") ?? "",
        resource: "https://api.fidyapp.com/mcp",
      };
      for (const changed of [
        { ...admission, userId: "20000000-0000-4000-8000-000000000001" },
        { ...admission, connectionId: "20000000-0000-4000-8000-000000000001" },
        { ...admission, clientId: "20000000-0000-4000-8000-000000000001" },
        { ...admission, resource: "https://evil.example/mcp" },
      ]) {
        expect((yield* wait(fixture.refreshCoordinate(row.user_id, changed))).status).not.toBe(200);
        yield* assertRefreshUnchanged(fixture);
      }
      expect(
        (yield* wait(fixture.refreshCoordinate("20000000-0000-4000-8000-000000000001", admission)))
          .status
      ).toBe(503);
      yield* assertRefreshUnchanged(fixture);
      expect(
        (yield* wait(
          refreshFixture({ ...fixture, refresh: token.refresh_token, scope: Option.none() })
        )).status
      ).toBe(200);
    })
  ));

it("bounds token delivery waiting to five seconds and cancels queued refresh without later minting or blind retry", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const gate = fixture.holdRefresh();
      const pending = refreshFixture({
        ...fixture,
        refresh: token.refresh_token,
        scope: Option.none(),
      });
      yield* wait(gate.waiting);
      const refused = yield* wait(pending);
      expect(refused.status).toBe(503);
      expect(yield* wait(refused.json())).toEqual({ error: "temporarily_unavailable" });
      gate.release();
      yield* wait(gate.settled);
      yield* assertRefreshUnchanged(fixture);
      yield* assertReleased(fixture.db);
    })
  ));

it("cancels a streamed refresh body, releases admission and exposes no proof in failures or logs", () => {
  const abort = new AbortController();
  return Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const reading = Promise.withResolvers<void>();
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>(
        {
          pull: (): void => reading.resolve(),
          cancel: (): void => {
            cancelled = true;
          },
        },
        { highWaterMark: 0 }
      );
      const pending = fixture.send("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        duplex: "half",
        signal: abort.signal,
      });
      yield* wait(reading.promise);
      abort.abort();
      const refused = yield* Effect.exit(wait(pending));
      deepStrictEqual(
        refused,
        Exit.fail(
          new TestFailure({
            cause: new Error("All fibers interrupted without error"),
          })
        )
      );
      expect(cancelled).toBe(true);
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(refused)
      ).not.toContain(token.refresh_token);
      yield* assertRefreshUnchanged(fixture);
      yield* assertReleased(fixture.db);
    })
  );
});

it("keeps refresh success/refusal telemetry and persisted lifecycle evidence metadata-only", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const response = yield* wait(
        refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
      );
      const winner = yield* Schema.decodeUnknownEffect(TokenFixture)(yield* wait(response.json()));
      const refused = yield* wait(
        refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
      );
      expect(yield* wait(refused.json())).toEqual({ error: "invalid_grant" });
      const metadata: Array<unknown> = [];
      for (const table of [
        "oauth_access_credentials",
        "oauth_refresh_credentials",
        "oauth_refresh_events",
        "oauth_revocation_consents",
      ]) {
        metadata.push(yield* wait(fixture.db.prepare(`SELECT * FROM ${table}`).all()));
      }
      const exported = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        log.mock.calls
      );
      expect(log.mock.calls.length).toBeGreaterThan(0);
      const stored = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(metadata);
      for (const secret of [
        original.access_token,
        original.refresh_token,
        winner.access_token,
        winner.refresh_token,
      ]) {
        expect(exported).not.toContain(secret);
        expect(stored).not.toContain(secret);
      }
      for (const forbidden of [
        "oauth-refresh:",
        "https://",
        "connectionId",
        "digest",
        "BootstrapUnavailable",
        "D1_ERROR",
      ]) {
        expect(exported).not.toContain(forbidden);
      }
    })
  ));

it.each([
  { guard: "foreign_user", status: 400 },
  { guard: "stale_session", status: 401 },
  { guard: "hostile_origin", status: 403 },
  { guard: "unrequested_scope", status: 400 },
  { guard: "revoked_consent", status: 503 },
])(
  "refuses schema-valid approval with $guard and leaves no grant, Consent or callback code",
  ({ guard, status }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* reviewedFixture();
        const choice = yield* Schema.decodeEffect(Schema.fromJsonString(OAuthReviewChoice))(
          fixture.choice
        );
        let headers = fixture.headers;
        let payload = choice;
        if (guard === "foreign_user") {
          headers = { ...headers, cookie: yield* sessionFor({ db: fixture.db, index: 2 }) };
        }
        if (guard === "stale_session") {
          yield* wait(
            fixture.db
              .prepare(
                "UPDATE web_sessions SET created_at_ms = created_at_ms - 600000, fresh_until_ms = fresh_until_ms - 600000, idle_expires_at_ms = idle_expires_at_ms - 600000, hard_expires_at_ms = hard_expires_at_ms - 600000"
              )
              .run()
          );
        }
        if (guard === "hostile_origin") headers = { ...headers, origin: "https://evil.example" };
        if (guard === "unrequested_scope") payload = { ...choice, scopes: ["read", "write"] };
        if (guard === "revoked_consent") {
          yield* wait(
            fixture.db
              .prepare(
                "INSERT INTO consent_user_revocations(id,user_id,grant_record_id,session_id,occurred_at_ms) VALUES ('revoked',?,'grant-test','10000000-0000-4000-8000-000000000003',?)"
              )
              .bind("10000000-0000-4000-8000-000000000001", yield* Clock.currentTimeMillis)
              .run()
          );
        }
        const body = yield* Schema.encodeEffect(Schema.fromJsonString(OAuthReviewChoice))(payload);
        const rejected = yield* wait(
          fixture.send("/web/oauth/connect", { method: "POST", headers, body })
        );
        expect(rejected.status).toBe(status);
        expect(yield* wait(rejected.text())).not.toContain('"callback"');
        for (const table of [
          "oauth_connections",
          "oauth_grant_consents",
          "oauth_codes",
          "oauth_access_credentials",
          "oauth_refresh_credentials",
        ]) {
          expect(
            yield* wait(
              fixture.db.prepare(`SELECT count(*) FROM ${table}`).first<number>("count(*)")
            )
          ).toBe(0);
        }
      })
    )
);
