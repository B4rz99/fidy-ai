import { Clock, DateTime, Effect, Exit, Option, Schema } from "effect";
import { deepStrictEqual } from "node:assert";
import { afterEach, expect, it, vi } from "vitest";
import { reviewRequest } from "./internal/review";
import { manageConnections } from "./internal/management";
import { BootstrapUnavailable } from "./internal/bootstrap";
import { OAuthReviewChoice } from "../../src/shell/oauth-agents/contract";
import { makeAudit } from "../../src/shell/audit/runtime";
import {
  TokenFixture,
  approveAgain,
  approvedFixture,
  exchangeFixture,
  mcpFixture,
  refreshFixture,
  reviewedFixture,
  sessionFor,
  wait,
} from "./oauth-ingress.test-fixture";

afterEach(() => vi.restoreAllMocks());

it("lists distinct owned agent connections with canonical activity and no credential material", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const second = yield* approveAgain(fixture);
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      for (let call = 0; call < 5; call++) {
        yield* wait(
          mcpFixture({
            send: fixture.send,
            bearer: token.access_token,
            method: "tools/call",
            name: "categories.listCategories",
            args: {},
          })
        );
      }
      const other = yield* sessionFor({ db: fixture.db, index: 2 });
      const listed = yield* wait(
        fixture.send("/web/oauth/connections", { headers: fixture.headers })
      );
      expect(listed.status).toBe(200);
      const body = yield* Schema.decodeUnknownEffect(Schema.Json)(yield* wait(listed.json()));
      expect(body).toMatchObject({
        connections: [
          { claimedClientName: "<img src=x onerror=alert(1)>", scopes: ["read"], state: "active" },
          { claimedClientName: "<img src=x onerror=alert(1)>", scopes: ["read"], state: "active" },
        ],
      });
      const activity = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          connections: Schema.Array(Schema.Struct({ recentActivity: Schema.Array(Schema.Json) })),
        })
      )(body);
      expect(
        activity.connections
          .map((item) => item.recentActivity.length)
          .sort((left, right) => left - right)
      ).toEqual([0, 3]);
      const text = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(body);
      expect(text).toContain(fixture.connectionId);
      expect(text).toContain(second.connectionId);
      expect(text).toContain("categories.listCategories");
      expect(text).not.toContain(token.access_token);
      expect(text).not.toContain(token.refresh_token);
      expect(text).not.toContain("digest");
      const isolated = yield* wait(
        fixture.send("/web/oauth/connections", { headers: { ...fixture.headers, cookie: other } })
      );
      expect(yield* wait(isolated.json())).toEqual({ connections: [], nextCursor: null });
      expect(listed.headers.get("cache-control")).toBe("no-store");
    })
  ));

it("revokes one agent atomically across restart without revoking another connection", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const second = yield* approveAgain(fixture);
      const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const other = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture({ ...fixture, body: second.body }))).json())
      );
      const discovered = yield* wait(
        mcpFixture({ send: fixture.send, bearer: original.access_token, method: "tools/list" })
      );
      expect(yield* wait(discovered.text())).toContain("categories.listCategories");
      const revoked = yield* wait(
        fixture.send("/web/oauth/revoke", {
          method: "POST",
          headers: fixture.headers,
          body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
            connectionId: fixture.connectionId,
          }),
        })
      );
      expect(revoked.status).toBe(200);
      expect(yield* wait(revoked.json())).toEqual({ revoked: true });
      fixture.restartCoordinators();
      expect(
        (yield* wait(
          mcpFixture({
            send: fixture.send,
            bearer: original.access_token,
            method: "tools/call",
            name: "categories.listCategories",
            args: {},
          })
        )).status
      ).toBe(401);
      expect(
        (yield* wait(
          refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
        )).status
      ).toBe(400);
      expect(
        (yield* wait(
          mcpFixture({
            send: fixture.send,
            bearer: other.access_token,
            method: "tools/call",
            name: "categories.listCategories",
            args: {},
          })
        )).status
      ).toBe(200);
      const evidence = yield* wait(
        fixture.db
          .prepare("SELECT connection_id,reason,session_id FROM oauth_user_revocation_consents")
          .all()
      );
      expect(evidence.results).toEqual([
        {
          connection_id: fixture.connectionId,
          reason: "user_one",
          session_id: "10000000-0000-4000-8000-000000000003",
        },
      ]);
      expect(
        Option.isNone(
          yield* Effect.option(
            wait(
              fixture.db
                .prepare("UPDATE oauth_user_revocation_consents SET reason = 'user_all'")
                .run()
            )
          )
        )
      ).toBe(true);
      expect(
        Option.isNone(
          yield* Effect.option(
            wait(fixture.db.prepare("DELETE FROM oauth_user_revocation_consents").run())
          )
        )
      ).toBe(true);
    })
  ));

it.each(["wrong-user", "forged-session", "stale-session", "csrf", "oauth-bearer"] as const)(
  "refuses %s browser revocation without exposing or changing the owned connection",
  (kind) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* approvedFixture();
        const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
          yield* wait((yield* wait(exchangeFixture(fixture))).json())
        );
        const headers = { ...fixture.headers };
        if (kind === "wrong-user") headers.cookie = yield* sessionFor({ db: fixture.db, index: 2 });
        if (kind === "forged-session" || kind === "oauth-bearer") {
          headers.cookie = "__Host-fidy_session=forged";
        }
        if (kind === "csrf") headers.origin = "https://evil.example";
        if (kind === "stale-session") {
          const now = yield* Clock.currentTimeMillis;
          yield* wait(
            fixture.db
              .prepare(
                "UPDATE web_sessions SET created_at_ms = ?, fresh_until_ms = ?, hard_expires_at_ms = ?"
              )
              .bind(now - 600001, now - 1, now - 600001 + 7776000000)
              .run()
          );
        }
        const response = yield* wait(
          fixture.send("/web/oauth/revoke", {
            method: "POST",
            headers: {
              ...headers,
              ...(kind === "oauth-bearer" ? { authorization: `Bearer ${token.access_token}` } : {}),
            },
            body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
              connectionId: fixture.connectionId,
            }),
          })
        );
        const statuses = {
          "wrong-user": 400,
          csrf: 403,
          "forged-session": 401,
          "stale-session": 401,
          "oauth-bearer": 401,
        };
        expect(response.status).toBe(statuses[kind]);
        expect(yield* wait(response.text())).not.toContain(fixture.connectionId);
        expect(
          (yield* wait(
            mcpFixture({
              send: fixture.send,
              bearer: token.access_token,
              method: "tools/call",
              name: "categories.listCategories",
              args: {},
            })
          )).status
        ).toBe(200);
        expect(
          yield* wait(
            fixture.db
              .prepare("SELECT count(*) FROM oauth_user_revocation_consents")
              .first<number>("count(*)")
          )
        ).toBe(0);
      })
    )
);

it("revokes all owned agents while a refresh is queued, leaving another User and committed canonical evidence intact", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const second = yield* approveAgain(fixture);
      const otherCookie = yield* sessionFor({ db: fixture.db, index: 2 });
      yield* wait(
        fixture.db
          .prepare(
            "INSERT INTO onboarding_consent_records VALUES ('other-grant-test', ?, '{}', 'disclosure', 'decision', 1, 1)"
          )
          .bind("20000000-0000-4000-8000-000000000001")
          .run()
      );
      const other = yield* approveAgain({
        ...fixture,
        headers: { ...fixture.headers, cookie: otherCookie },
      });
      const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const secondToken = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture({ ...fixture, body: second.body }))).json())
      );
      const otherToken = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture({ ...fixture, body: other.body }))).json())
      );
      yield* wait(
        mcpFixture({
          send: fixture.send,
          bearer: original.access_token,
          method: "tools/call",
          name: "categories.listCategories",
          args: {},
        })
      );
      const gate = fixture.holdRefresh();
      const queued = refreshFixture({
        ...fixture,
        refresh: original.refresh_token,
        scope: Option.none(),
      });
      yield* wait(gate.waiting);
      const revoked = yield* wait(
        fixture.send("/web/oauth/revoke-all", {
          method: "POST",
          headers: fixture.headers,
          body: "{}",
        })
      );
      expect(revoked.status).toBe(200);
      gate.release();
      expect((yield* wait(queued)).status).toBe(400);
      fixture.restartCoordinators();
      for (const token of [original, secondToken]) {
        expect(
          (yield* wait(
            mcpFixture({
              send: fixture.send,
              bearer: token.access_token,
              method: "tools/call",
              name: "categories.listCategories",
              args: {},
            })
          )).status
        ).toBe(401);
        expect(
          (yield* wait(
            refreshFixture({ ...fixture, refresh: token.refresh_token, scope: Option.none() })
          )).status
        ).toBe(400);
      }
      expect(
        (yield* wait(
          mcpFixture({
            send: fixture.send,
            bearer: otherToken.access_token,
            method: "tools/call",
            name: "categories.listCategories",
            args: {},
          })
        )).status
      ).toBe(200);
      expect(
        yield* makeAudit({ database: fixture.db }).query({
          userId: "10000000-0000-4000-8000-000000000001",
          limit: 10,
        })
      ).toHaveLength(1);
      const repeated = yield* wait(
        fixture.send("/web/oauth/revoke-all", {
          method: "POST",
          headers: fixture.headers,
          body: "{}",
        })
      );
      expect(repeated.status).toBe(200);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_user_revocation_consents")
            .first<number>("count(*)")
        )
      ).toBe(2);
    })
  ));

it("does not revoke any agent when append-only revocation evidence is unavailable", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const second = yield* approveAgain(fixture);
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      yield* wait(
        fixture.db
          .prepare(
            `CREATE TRIGGER reject_oauth_evidence BEFORE INSERT ON oauth_user_revocation_consents WHEN NEW.connection_id = '${second.connectionId}' BEGIN SELECT RAISE(ABORT,'unavailable'); END`
          )
          .run()
      );
      const response = yield* wait(
        fixture.send("/web/oauth/revoke-all", {
          method: "POST",
          headers: fixture.headers,
          body: "{}",
        })
      );
      expect(response.status).toBe(503);
      expect(yield* wait(response.json())).toEqual({ error: "temporarily_unavailable" });
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_connections WHERE revoked_at_ms IS NOT NULL")
            .first<number>("count(*)")
        )
      ).toBe(0);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_user_revocation_consents")
            .first<number>("count(*)")
        )
      ).toBe(0);
      expect(
        (yield* wait(
          refreshFixture({ ...fixture, refresh: token.refresh_token, scope: Option.none() })
        )).status
      ).toBe(200);
    })
  ));

it("keeps corrupt retained OAuth review and connection dates in the typed failure channel", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const reviewed = yield* reviewedFixture();
      const choice = yield* Schema.decodeEffect(Schema.fromJsonString(OAuthReviewChoice))(
        reviewed.choice
      );
      yield* wait(
        reviewed.db
          .prepare("UPDATE oauth_review_requests SET created_at_ms=?,expires_at_ms=? WHERE id=?")
          .bind(8_640_000_000_000_001 - 600_000, 8_640_000_000_000_001, choice.requestId)
          .run()
      );
      const typedCorruption = new BootstrapUnavailable();
      deepStrictEqual(
        yield* Effect.exit(
          reviewRequest({
            db: reviewed.db,
            request: new Request(
              `https://api.fidyapp.com/web/oauth/review?requestId=${choice.requestId}`,
              { headers: reviewed.headers }
            ),
            browserOrigin: "https://app.fidyapp.com",
            current: DateTime.nowUnsafe().epochMilliseconds,
            admitUser: () => Effect.void,
          })
        ),
        Exit.fail(typedCorruption)
      );
      expect(
        (yield* wait(
          reviewed.send(`/web/oauth/review?requestId=${choice.requestId}`, {
            headers: reviewed.headers,
          })
        )).status
      ).toBe(503);
      expect(
        (yield* wait(reviewed.db.prepare("SELECT id FROM oauth_connections").all())).results
      ).toEqual([]);
      const approved = yield* approvedFixture();
      // Inject retained corruption without changing the production grant immutability fence.
      yield* wait(approved.db.exec("DROP TRIGGER oauth_connection_immutable"));
      for (const dates of [
        { expiry: -8_640_000_000_000_001, revokedAt: null },
        { expiry: 8_640_000_000_000_001, revokedAt: null },
        {
          expiry: DateTime.add(DateTime.nowUnsafe(), { days: 7 }).epochMilliseconds,
          revokedAt: 8_640_000_000_000_001,
        },
      ]) {
        yield* wait(
          approved.db
            .prepare(
              "UPDATE oauth_connections SET approved_at_ms=?,expires_at_ms=?,revoked_at_ms=? WHERE id=?"
            )
            .bind(dates.expiry - 1, dates.expiry, dates.revokedAt, approved.connectionId)
            .run()
        );
        deepStrictEqual(
          yield* Effect.exit(
            manageConnections({
              db: approved.db,
              request: new Request("https://api.fidyapp.com/web/oauth/connections", {
                headers: approved.headers,
              }),
              browserOrigin: "https://app.fidyapp.com",
              current: DateTime.nowUnsafe().epochMilliseconds,
              admitUser: () => Effect.void,
              coordinator: {
                getByName: () => {
                  throw new Error("Connection listing must not revoke work");
                },
              },
            })
          ),
          Exit.fail(typedCorruption)
        );
        expect(
          (yield* wait(approved.send("/web/oauth/connections", { headers: approved.headers })))
            .status
        ).toBe(503);
      }
    })
  ));

it("reports malformed connection metadata and unavailable canonical activity rather than a false empty list", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      yield* wait(fixture.db.prepare("DROP TRIGGER oauth_connection_immutable").run());
      yield* wait(fixture.db.prepare("UPDATE oauth_connections SET scopes_json = '[]'").run());
      expect(
        (yield* wait(fixture.send("/web/oauth/connections", { headers: fixture.headers }))).status
      ).toBe(503);
      yield* wait(
        fixture.db.prepare("UPDATE oauth_connections SET scopes_json = '[\"read\"]'").run()
      );
      yield* wait(fixture.db.prepare("ALTER TABLE pat_audit RENAME TO unavailable_audit").run());
      expect(
        (yield* wait(fixture.send("/web/oauth/connections", { headers: fixture.headers }))).status
      ).toBe(503);
    })
  ));

it("keeps OAuth revocation, PAT-wide revocation, Hosted Agent Sessions and browser logout independent", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const current = yield* Clock.currentTimeMillis;
      const issued = yield* wait(
        fixture.send("/pats", {
          method: "POST",
          headers: fixture.headers,
          body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
            requestId: "10000000-0000-4000-8000-000000000005",
            grant: {
              recipientLabel: "Agente directo",
              scopes: ["read"],
              lifetimeDays: 7,
              reviewExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(current + 604800000)),
            },
          }),
        })
      );
      expect(issued.status).toBe(200);
      const pat = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ data: Schema.Struct({ bearer: Schema.String }) })
      )(yield* wait(issued.json()));
      yield* wait(
        fixture.db
          .prepare(
            "INSERT INTO hosted_agent_sessions(id,user_id,consent_basis_json,started_at_ms,status) VALUES ('10000000-0000-4000-8000-000000000009','10000000-0000-4000-8000-000000000001','{}',?,'active')"
          )
          .bind(current)
          .run()
      );
      const revoked = yield* wait(
        fixture.send("/web/oauth/revoke-all", {
          method: "POST",
          headers: fixture.headers,
          body: "{}",
        })
      );
      expect(revoked.status).toBe(200);
      expect(
        (yield* wait(
          fixture.send("/categories", { headers: { authorization: `Bearer ${pat.data.bearer}` } })
        )).status
      ).toBe(200);
      expect(
        yield* wait(
          fixture.db.prepare("SELECT status FROM hosted_agent_sessions").first<string>("status")
        )
      ).toBe("active");
      const replacement = yield* approveAgain(fixture);
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture({ ...fixture, body: replacement.body }))).json())
      );
      expect(
        (yield* wait(fixture.send("/pats", { method: "DELETE", headers: fixture.headers }))).status
      ).toBe(200);
      expect(
        (yield* wait(
          mcpFixture({
            send: fixture.send,
            bearer: token.access_token,
            method: "tools/call",
            name: "categories.listCategories",
            args: {},
          })
        )).status
      ).toBe(200);
      expect(
        (yield* wait(
          fixture.send("/web/session/logout", { method: "POST", headers: fixture.headers })
        )).status
      ).toBe(204);
      expect(
        (yield* wait(
          mcpFixture({
            send: fixture.send,
            bearer: token.access_token,
            method: "tools/call",
            name: "categories.listCategories",
            args: {},
          })
        )).status
      ).toBe(200);
      expect(
        (yield* wait(
          refreshFixture({
            ...fixture,
            body: replacement.body,
            refresh: token.refresh_token,
            scope: Option.none(),
          })
        )).status
      ).toBe(200);
    })
  ));

it("rechecks queued browser revocation subject, freshness and deadline before recording any effects", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const current = yield* Clock.currentTimeMillis;
      const admission = {
        userId: "10000000-0000-4000-8000-000000000001",
        sessionId: "10000000-0000-4000-8000-000000000003",
        connectionId: fixture.connectionId,
        deadlineAtMs: current + 5000,
      };
      expect(
        (yield* wait(fixture.revokeCoordinate("20000000-0000-4000-8000-000000000001", admission)))
          .status
      ).toBe(503);
      expect(
        (yield* wait(
          fixture.revokeCoordinate(admission.userId, { ...admission, deadlineAtMs: current - 1 })
        )).status
      ).toBe(503);
      yield* wait(
        fixture.db
          .prepare("UPDATE web_sessions SET revoked_at_ms = ? WHERE id = ?")
          .bind(current, admission.sessionId)
          .run()
      );
      expect((yield* wait(fixture.revokeCoordinate(admission.userId, admission))).status).toBe(400);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_connections WHERE revoked_at_ms IS NOT NULL")
            .first<number>("count(*)")
        )
      ).toBe(0);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_user_revocation_consents")
            .first<number>("count(*)")
        )
      ).toBe(0);
    })
  ));

it("pages retained connections and refuses oversized revoke-all atomically rather than publishing a partial success", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      yield* wait(
        fixture.db.batch([
          fixture.db
            .prepare(`WITH RECURSIVE copies(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM copies WHERE n < 1024)
      INSERT INTO oauth_connections(id,request_id,user_id,client_id,claimed_client_name,redirect_uri,resource,scopes_json,approved_at_ms,expires_at_ms,refresh_allowed)
      SELECT '30000000-0000-4000-8000-' || printf('%012d',n),'copy-' || n,g.user_id,g.client_id,g.claimed_client_name,g.redirect_uri,g.resource,g.scopes_json,g.approved_at_ms,g.expires_at_ms,g.refresh_allowed FROM copies,oauth_connections g WHERE g.id = ?`)
            .bind(fixture.connectionId),
          fixture.db
            .prepare(`INSERT INTO oauth_grant_consents(id,connection_id,user_id,session_id,disclosure_revision,disclosure_text,accepted_at_ms)
      SELECT 'copy-' || g.id,g.id,g.user_id,c.session_id,c.disclosure_revision,c.disclosure_text,c.accepted_at_ms FROM oauth_connections g,oauth_grant_consents c WHERE c.connection_id = ? AND g.id != ?`)
            .bind(fixture.connectionId, fixture.connectionId),
        ])
      );
      const Page = Schema.Struct({
        connections: Schema.Array(Schema.Struct({ connectionId: Schema.String })),
        nextCursor: Schema.OptionFromNullOr(Schema.String),
      });
      const first = yield* Schema.decodeUnknownEffect(Page)(
        yield* wait(
          (yield* wait(fixture.send("/web/oauth/connections", { headers: fixture.headers }))).json()
        )
      );
      expect(first.connections).toHaveLength(25);
      expect(Option.isSome(first.nextCursor)).toBe(true);
      const second = yield* Schema.decodeUnknownEffect(Page)(
        yield* wait(
          (yield* wait(
            fixture.send(
              `/web/oauth/connections?after=${Option.getOrElse(first.nextCursor, () => "")}`,
              { headers: fixture.headers }
            )
          )).json()
        )
      );
      expect(second.connections).toHaveLength(25);
      expect(
        new Set([...first.connections, ...second.connections].map((item) => item.connectionId)).size
      ).toBe(50);
      const refusal = yield* wait(
        fixture.send("/web/oauth/revoke-all", {
          method: "POST",
          headers: fixture.headers,
          body: "{}",
        })
      );
      expect(refusal.status).toBe(503);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_connections WHERE revoked_at_ms IS NOT NULL")
            .first<number>("count(*)")
        )
      ).toBe(0);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_user_revocation_consents")
            .first<number>("count(*)")
        )
      ).toBe(0);
    })
  ));
