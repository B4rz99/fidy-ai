import { executeCanonicalWork } from "../canonical-operations/operations";
import { categoryIds } from "../../src/core/categories/contract";
import { CanonicalOperationId } from "../../src/core/canonical-operations/contract";
import { Clock, DateTime, Deferred, Effect, Exit, Fiber, Option, Predicate, Schema } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { OAuthCanonicalAdmission } from "../../src/shell/mcp/contract";
import { authenticateOAuth } from "./operations";
import { recordOAuthCall } from "../../src/shell/audit/operations";
import { liveOAuthAuthority } from "../../src/shell/oauth-agents/operations";
import { browseTransactions } from "../transactions/operations";
import {
  TestFailure,
  TokenFixture,
  approvedFixture,
  clockAt,
  exchangeFixture,
  mcpFixture,
  refreshFixture,
  revokeFixtureConsent,
  sessionFor,
  transactionArguments,
  transactionChildren,
  wait,
} from "./oauth-ingress.test-fixture";

afterEach(() => vi.restoreAllMocks());

const authenticatedHistoryFixture = Effect.fn(function* () {
  const fixture = yield* approvedFixture({
    scopes: ["read", "write"],
    lifetimeDays: 7,
  });
  const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
    yield* wait((yield* wait(exchangeFixture(fixture))).json())
  );
  const current = yield* Clock.currentTimeMillis;
  const caller = yield* authenticateOAuth({
    db: fixture.db,
    current,
    request: new Request("https://api.fidyapp.com/mcp", {
      headers: { authorization: `Bearer ${token.access_token}` },
    }),
  });
  if (Option.isNone(caller)) {
    return yield* new TestFailure({ cause: "fixture OAuth authentication failed" });
  }
  const subject = caller.value.subject;
  const read = (db: D1Database = fixture.db): Effect.Effect<Response> =>
    browseTransactions({
      db,
      selection: {
        subject,
        request: new Request("https://core.internal/transactions"),
        search: false,
        id: Option.none(),
      },
    });
  const audit = (
    id: string,
    operation = "transactions.listTransactions",
    outcome: "accepted" | "rejected" = "accepted"
  ): D1PreparedStatement => {
    const auditStatement = recordOAuthCall({
      authority: liveOAuthAuthority({ subject, current }),
      id,
      current,
      operation: CanonicalOperationId.make(operation),
      outcome,
    });
    return fixture.db.prepare(auditStatement.sql).bind(...auditStatement.params);
  };

  return { ...fixture, current, subject, read, audit };
});

const countAuditEntries = ({
  db,
  userId,
  current,
}: Readonly<{ db: D1Database; userId: string; current: number }>): Promise<number> => {
  const dayStart = Math.floor(current / 86_400_000) * 86_400_000;
  return db
    .prepare(`SELECT count(*) FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit WHERE user_id=?
    AND (pat_id IS NOT NULL OR (oauth_connection_id IS NOT NULL AND oauth_credential_id IS NOT NULL))
    AND operation NOT LIKE 'pats.%' AND operation != 'operations.executeAtomicBatch'
    AND occurred_at_ms >= ? AND occurred_at_ms < ?`)
    .bind(userId, dayStart, dayStart + 86_400_000)
    .first<number>("count(*)")
    .then((count) => count ?? 0);
};

it("keeps the OAuth history caller scope open until its started native query and Audit batch settles", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* authenticatedHistoryFixture();
      const ready = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let batches = 0;
      const held = new Proxy(fixture.db, {
        get: (target, key): unknown => {
          if (key === "batch") {
            return (statements: D1PreparedStatement[]) => {
              batches += 1;
              const started = target.batch(statements);
              ready.resolve();
              return started.then((results) => release.promise.then(() => results));
            };
          }
          const value: unknown = Reflect.get(target, key);
          return Predicate.isFunction(value) ? value.bind(target) : value;
        },
      });
      yield* Effect.gen(function* () {
        const closed = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        const child = yield* fixture
          .read(held)
          .pipe(Effect.ensuring(Deferred.succeed(closed, undefined)), Effect.forkScoped);
        yield* wait(ready.promise);
        const interruption = yield* Fiber.interrupt(child).pipe(
          Effect.andThen(Deferred.succeed(interrupted, undefined)),
          Effect.forkScoped
        );
        yield* Effect.sleep("30 millis");
        expect(yield* Deferred.isDone(closed)).toBe(false);
        expect(yield* Deferred.isDone(interrupted)).toBe(false);
        release.resolve();
        yield* Fiber.join(interruption);
        const exit = yield* Fiber.await(child);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(batches).toBe(1);
        expect(
          yield* wait(
            countAuditEntries({
              db: fixture.db,
              userId: fixture.subject.userId,
              current: fixture.current,
            })
          )
        ).toBe(1);
      }).pipe(Effect.ensuring(Effect.sync(() => release.resolve())), Effect.scoped);
    })
  ));

it("resamples OAuth authority at canonical commit using the invocation Clock while preserving native expiry guards", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* authenticatedHistoryFixture();
      const expires = fixture.current + 60_000;
      yield* wait(
        fixture.db
          .prepare(
            "UPDATE oauth_credentials AS oauth_credentials SET expires_at_ms = ? WHERE kind='access' AND id = ?"
          )
          .bind(expires, fixture.subject.credentialId)
          .run()
      );
      const live = yield* Clock.Clock;
      const invoke = (clock: Clock.Clock): Effect.Effect<Response> =>
        executeCanonicalWork({
          db: fixture.db,
          subject: fixture.subject,
          current: fixture.current,
          bucket: Option.none(),
          inference: Option.none(),
          hostedFence: Option.none(),
          oauthConfirmation: Option.none(),
          work: {
            _tag: "Call",
            operation: CanonicalOperationId.make("transactions.createTransaction"),
            input: transactionArguments,
          },
        }).pipe(Effect.provideService(Clock.Clock, clock));
      const expired = yield* invoke(clockAt({ live, current: expires, read: () => expires }));
      expect(expired.status).toBe(401);
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
        )
      ).toBe(0);
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM source_attestations").first<number>("count(*)")
        )
      ).toBe(0);
      expect(
        yield* wait(
          countAuditEntries({
            db: fixture.db,
            userId: fixture.subject.userId,
            current: fixture.current,
          })
        )
      ).toBe(0);
      const healthy = yield* invoke(
        clockAt({ live, current: fixture.current, read: () => fixture.current })
      );
      expect(healthy.status).toBe(201);
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
        )
      ).toBe(1);
      expect(
        yield* wait(
          countAuditEntries({
            db: fixture.db,
            userId: fixture.subject.userId,
            current: fixture.current,
          })
        )
      ).toBe(1);
    })
  ));

it("resamples OAuth authority after a native canonical abort before classifying its refusal", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* authenticatedHistoryFixture();
      const expires = fixture.current + 60_000;
      yield* wait(
        fixture.db
          .prepare(
            "UPDATE oauth_credentials AS oauth_credentials SET expires_at_ms = ? WHERE kind='access' AND id = ?"
          )
          .bind(expires, fixture.subject.credentialId)
          .run()
      );
      yield* wait(
        fixture.db.exec(
          "CREATE TRIGGER fixture_commit_abort BEFORE INSERT ON transactions BEGIN SELECT RAISE(ABORT, 'fixture_commit_abort'); END"
        )
      );
      let instant = fixture.current;
      let batches = 0;
      const aborted = new Proxy(fixture.db, {
        get: (target, key): unknown => {
          if (key === "batch") {
            return (statements: D1PreparedStatement[]) => {
              batches += 1;
              return target.batch(statements).catch((cause: unknown) => {
                instant = expires;
                throw cause;
              });
            };
          }
          const value: unknown = Reflect.get(target, key);
          return Predicate.isFunction(value) ? value.bind(target) : value;
        },
      });
      const live = yield* Clock.Clock;
      const clock = clockAt({ live, current: fixture.current, read: () => instant });
      const response = yield* executeCanonicalWork({
        db: aborted,
        subject: fixture.subject,
        current: fixture.current,
        bucket: Option.none(),
        inference: Option.none(),
        hostedFence: Option.none(),
        oauthConfirmation: Option.none(),
        work: {
          _tag: "Call",
          operation: CanonicalOperationId.make("transactions.createTransaction"),
          input: transactionArguments,
        },
      }).pipe(Effect.provideService(Clock.Clock, clock));
      expect(response.status).toBe(401);
      expect(batches).toBe(1);
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
        )
      ).toBe(0);
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM source_attestations").first<number>("count(*)")
        )
      ).toBe(0);
      expect(
        yield* wait(
          countAuditEntries({
            db: fixture.db,
            userId: fixture.subject.userId,
            current: fixture.current,
          })
        )
      ).toBe(0);
    })
  ));

it("records fully attributed OAuth reads under the same User", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture({
        scopes: ["read"],
        lifetimeDays: 7,
      });
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const userId = yield* wait(
        fixture.db
          .prepare("SELECT user_id FROM oauth_connections WHERE id = ?")
          .bind(fixture.connectionId)
          .first<string>("user_id")
      );
      if (userId === null) throw new Error("Fixture connection missing");
      const current = yield* Clock.currentTimeMillis;
      const before = yield* wait(countAuditEntries({ db: fixture.db, userId, current }));
      for (let index = 0; index < 3; index += 1) {
        const response = yield* wait(
          mcpFixture({
            retryKey: Option.none(),
            send: fixture.send,
            bearer: token.access_token,
            method: "tools/call",
            name: "transactions.listTransactions",
            args: { query: {} },
          })
        );
        expect(response.status).toBe(200);
        expect(yield* wait(response.json())).toMatchObject({ result: { isError: false } });
      }
      expect(yield* wait(countAuditEntries({ db: fixture.db, userId, current }))).toBe(before + 3);
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit WHERE oauth_connection_id = ? AND oauth_credential_id IS NOT NULL AND pat_id IS NULL AND outcome = 'accepted'"
            )
            .bind(fixture.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(3);
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit WHERE (pat_id IS NOT NULL OR (oauth_connection_id IS NOT NULL AND oauth_credential_id IS NOT NULL)) AND operation NOT LIKE 'pats.%' AND operation != 'operations.executeAtomicBatch' AND user_id = ?"
            )
            .bind(userId)
            .first<number>("count(*)")
        )
      ).toBe(before + 3);
    })
  ));

it("creates a Transaction through the ordinary OAuth mutation with one protected Audit and no PAT accounting", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture({
        scopes: ["write"],
        lifetimeDays: 7,
      });
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const response = yield* wait(
        mcpFixture({
          retryKey: Option.none(),
          send: fixture.send,
          bearer: token.access_token,
          method: "tools/call",
          name: "transactions.createTransaction",
          args: {
            payload: {
              money: { amount: "15000", currency: "COP" },
              direction: "outflow",
              occurredAt: "2026-10-03T12:00:00.000Z",
            },
          },
        })
      );
      const body = yield* wait(response.json());
      expect(body).toMatchObject({
        result: {
          isError: false,
          structuredContent: { data: { money: { amount: "15000", currency: "COP" } }, next: [] },
        },
      });
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
        )
      ).toBe(1);
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit WHERE oauth_connection_id = ? AND operation = 'transactions.createTransaction' AND outcome = 'accepted'"
            )
            .bind(fixture.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(1);
      expect(
        yield* wait(fixture.db.prepare("SELECT count(*) FROM pats").first<number>("count(*)"))
      ).toBe(0);
    })
  ));

it("returns the committed Transaction through MCP when native D1 settlement takes more than five seconds", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture({ scopes: ["read", "write"], lifetimeDays: 7 });
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const commit = fixture.holdMutationCommit();
      const pending = mcpFixture({
        ...fixture,
        bearer: token.access_token,
        retryKey: Option.none(),
        method: "tools/call",
        name: "transactions.createTransaction",
        args: {
          payload: {
            money: { amount: "25000", currency: "COP" },
            direction: "outflow",
            occurredAt: "2026-10-28T12:00:00.000Z",
            notes: "MCP regression capture",
          },
        },
      });
      yield* wait(commit.waiting);
      yield* Effect.sleep("6200 millis");
      commit.release();
      const response = yield* wait(pending);
      yield* wait(commit.settled);
      const body = yield* wait(response.json());
      expect(body).toMatchObject({
        result: {
          isError: false,
          structuredContent: {
            data: {
              money: { amount: "25000", currency: "COP" },
              notes: "MCP regression capture",
              revision: 0,
            },
          },
        },
      });
      const created = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          result: Schema.Struct({
            structuredContent: Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }),
          }),
        })
      )(body);
      const read = yield* wait(
        mcpFixture({
          ...fixture,
          bearer: token.access_token,
          retryKey: Option.none(),
          method: "tools/call",
          name: "transactions.getTransaction",
          args: { params: { id: created.result.structuredContent.data.id } },
        })
      );
      expect(yield* wait(read.json())).toMatchObject({
        result: {
          isError: false,
          structuredContent: {
            data: {
              id: created.result.structuredContent.data.id,
              revision: 0,
              money: { amount: "25000", currency: "COP" },
            },
          },
        },
      });
    })
  ));

it("commits an authorized OAuth atomic batch with exact correlated results and one Audit per child", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture({
        scopes: ["write"],
        lifetimeDays: 7,
      });
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const response = yield* wait(
        mcpFixture({
          retryKey: Option.none(),
          send: fixture.send,
          bearer: token.access_token,
          method: "tools/call",
          name: "operations.executeAtomicBatch",
          args: { payload: { calls: transactionChildren } },
        })
      );
      const result = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          result: Schema.Struct({
            isError: Schema.Boolean,
            structuredContent: Schema.Json,
            content: Schema.Array(
              Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
            ),
          }),
        })
      )(yield* wait(response.json()));
      expect(result.result.isError).toBe(false);
      expect(result.result.structuredContent).toMatchObject({
        data: {
          results: transactionChildren.map(({ callId, operation }) => ({
            callId,
            operation,
            output: { data: { money: { amount: "15000", currency: "COP" } }, next: [] },
          })),
        },
        next: [],
      });
      expect(
        yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(
          result.result.content[0]?.text ?? "null"
        )
      ).toEqual(result.result.structuredContent);
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
        )
      ).toBe(2);
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit WHERE oauth_connection_id = ? AND outcome = 'accepted'"
            )
            .bind(fixture.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(2);
    })
  ));

it("preserves the canonical owner's invalid ordinary OAuth mutation refusal", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture({
        scopes: ["write"],
        lifetimeDays: 7,
      });
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const response = yield* wait(
        mcpFixture({
          retryKey: Option.none(),
          send: fixture.send,
          bearer: token.access_token,
          method: "tools/call",
          name: "transactions.createTransaction",
          args: { payload: { money: { amount: "-1", currency: "COP" } } },
        })
      );
      expect(yield* wait(response.json())).toMatchObject({
        result: {
          isError: true,
          structuredContent: {
            error: { code: "validation_failed", message: "Invalid Transaction input." },
            next: [],
          },
        },
      });
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT operation, outcome FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit"
            )
            .all()
        )
      ).toMatchObject({
        results: [{ operation: "transactions.createTransaction", outcome: "rejected" }],
      });
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
        )
      ).toBe(0);
    })
  ));

const assertAttributedBatchRefusal = (
  db: D1Database,
  value: unknown,
  failure: string
): Effect.Effect<void, TestFailure> =>
  Effect.gen(function* () {
    if (failure !== "invalid" && failure !== "sensitive") return;
    const operation =
      failure === "invalid" ? "transactions.createTransaction" : "budgets.deleteBudget";
    expect(value).toMatchObject({
      result: {
        structuredContent: {
          error: {
            code: failure === "invalid" ? "validation_failed" : "user_action_required",
            failedCallIndex: 1,
            operation,
          },
        },
      },
    });
    expect(
      yield* wait(
        db
          .prepare(
            "SELECT operation, outcome FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit"
          )
          .all()
      )
    ).toMatchObject({ results: [{ operation, outcome: "rejected" }] });
  });

it.each(["invalid", "collision", "owner-collision", "hidden", "sensitive", "audit"])(
  "refuses an OAuth batch with %s work without partial domain effects or successful accounting",
  (failure) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const scopes = failure === "owner-collision" ? ["write", "dashboard"] : ["write"];
        const fixture = yield* approvedFixture({
          scopes,
          lifetimeDays: 7,
        });
        const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
          yield* wait((yield* wait(exchangeFixture(fixture))).json())
        );
        let second: Schema.Json = transactionChildren[1];
        if (failure === "invalid") {
          second = {
            ...transactionChildren[1],
            input: { payload: { money: { amount: "-1", currency: "COP" } } },
          };
        }
        if (failure === "collision") {
          second = { ...transactionChildren[1], callId: transactionChildren[0].callId };
        }
        if (failure === "hidden") {
          second = {
            ...transactionChildren[1],
            operation: "dashboard.initializeDashboard",
            input: {},
          };
        }
        if (failure === "sensitive") {
          second = {
            ...transactionChildren[1],
            operation: "budgets.deleteBudget",
            input: { params: { id: "30000000-0000-4000-8000-000000000001" } },
          };
        }
        if (failure === "audit") {
          yield* wait(
            fixture.db
              .prepare(
                "CREATE TRIGGER skip_oauth_mutation_audit BEFORE INSERT ON audit_entries WHEN NEW.record_type='credential_call' AND NEW.outcome = 'accepted' BEGIN SELECT RAISE(IGNORE); END"
              )
              .run()
          );
        }
        const response = yield* wait(
          mcpFixture({
            retryKey: Option.none(),
            send: fixture.send,
            bearer: token.access_token,
            method: "tools/call",
            name: "operations.executeAtomicBatch",
            args: {
              payload: {
                calls:
                  failure === "owner-collision"
                    ? transactionChildren.map((child) => ({
                        ...child,
                        operation: "dashboard.initializeDashboard",
                        input: {},
                      }))
                    : [transactionChildren[0], second],
              },
            },
          })
        );
        const value = yield* wait(response.json());
        expect(value).toMatchObject({
          result: { isError: true, structuredContent: { next: [] } },
        });
        yield* assertAttributedBatchRefusal(fixture.db, value, failure);
        expect(
          yield* wait(
            fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
          )
        ).toBe(0);
        expect(
          yield* wait(
            fixture.db.prepare("SELECT count(*) FROM source_attestations").first<number>("count(*)")
          )
        ).toBe(0);
        expect(
          yield* wait(
            fixture.db
              .prepare(
                "SELECT count(*) FROM (SELECT user_id,document_json,revision FROM user_documents WHERE kind='dashboard') AS dashboard_documents"
              )
              .first<number>("count(*)")
          )
        ).toBe(0);
        expect(
          yield* wait(
            fixture.db
              .prepare(
                "SELECT count(*) FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit WHERE outcome = 'accepted'"
              )
              .first<number>("count(*)")
          )
        ).toBe(0);
      })
    )
);

it.each(["empty", "oversized", "unattributed"])(
  "keeps %s OAuth batch failures at the canonical envelope boundary",
  (shape) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* approvedFixture({
          scopes: ["write"],
          lifetimeDays: 7,
        });
        const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
          yield* wait((yield* wait(exchangeFixture(fixture))).json())
        );
        let calls: ReadonlyArray<Schema.Json> = [];
        if (shape === "oversized") calls = Array.from({ length: 13 }, () => transactionChildren[0]);
        if (shape === "unattributed") calls = [{}];
        const response = yield* wait(
          mcpFixture({
            retryKey: Option.none(),
            send: fixture.send,
            bearer: token.access_token,
            method: "tools/call",
            name: "operations.executeAtomicBatch",
            args: { payload: { calls } },
          })
        );
        const value = yield* wait(response.json());
        expect(value).toMatchObject({
          result: {
            isError: true,
            structuredContent: { error: { code: "validation_failed" }, next: [] },
          },
        });
        expect(
          yield* wait(
            fixture.db
              .prepare(
                "SELECT operation, outcome FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit"
              )
              .all()
          )
        ).toMatchObject({
          results: [{ operation: "operations.executeAtomicBatch", outcome: "rejected" }],
        });
        expect(
          yield* wait(
            fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
          )
        ).toBe(0);
      })
    )
);

it("rejects read-only and cross-User mutation admissions at the authoritative coordinator without domain effects", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture({
        scopes: ["read"],
        lifetimeDays: 7,
      });
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const admitted = yield* authenticateOAuth({
        db: fixture.db,
        current: yield* Clock.currentTimeMillis,
        request: new Request("https://api.fidyapp.com/mcp", {
          headers: { authorization: `Bearer ${token.access_token}` },
        }),
      });
      if (Option.isNone(admitted)) return yield* Effect.die("Expected live fixture authority");
      const caller = admitted.value.subject;
      const admission = yield* Schema.encodeEffect(OAuthCanonicalAdmission)({
        userId: caller.userId,
        connectionId: caller.oauthConnectionId,
        credentialId: caller.credentialId,
        clientId: caller.clientId,
        resource: caller.resource,
        digest: Array.from(caller.digest),
        deadlineMilliseconds: (yield* Clock.currentTimeMillis) + 5000,
        operation: CanonicalOperationId.make("transactions.createTransaction"),
        input: transactionArguments,
      });
      const denied = yield* wait(fixture.coordinate(caller.userId, admission));
      expect(denied.status).toBe(403);
      expect(yield* wait(denied.json())).toMatchObject({ error: { code: "scope_missing" } });
      const peer = "10000000-0000-4000-8000-000000000002";
      expect((yield* wait(fixture.coordinate(peer, admission))).status).toBe(503);
      expect((yield* wait(fixture.coordinate(peer, { ...admission, userId: peer }))).status).toBe(
        401
      );
      const batch = yield* wait(
        mcpFixture({
          retryKey: Option.none(),
          send: fixture.send,
          bearer: token.access_token,
          method: "tools/call",
          name: "operations.executeAtomicBatch",
          args: { payload: { calls: transactionChildren } },
        })
      );
      expect(yield* wait(batch.json())).toMatchObject({
        result: { isError: true, structuredContent: { error: { code: "scope_missing" } } },
      });
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
        )
      ).toBe(0);
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit WHERE outcome = 'accepted'"
            )
            .first<number>("count(*)")
        )
      ).toBe(0);
    })
  ));

it("settles concurrent OAuth batches once per child and never retries ambiguous mutation delivery", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture({
        scopes: ["write"],
        lifetimeDays: 7,
      });
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      fixture.interceptQueryResponse(() =>
        Promise.resolve(new Response("undecodable-delivery", { status: 200 }))
      );
      const responses = yield* wait(
        Promise.all(
          [1, 2].map(() =>
            mcpFixture({
              retryKey: Option.none(),
              send: fixture.send,
              bearer: token.access_token,
              method: "tools/call",
              name: "operations.executeAtomicBatch",
              args: { payload: { calls: transactionChildren } },
            })
          )
        )
      );
      for (const response of responses) {
        expect(yield* wait(response.json())).toMatchObject({
          result: {
            isError: true,
            structuredContent: { error: { code: "unavailable" }, next: [] },
          },
        });
      }
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
        )
      ).toBe(4);
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit WHERE outcome = 'accepted' AND oauth_connection_id = ?"
            )
            .bind(fixture.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(4);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM canonical_request_leases")
            .first<number>("count(*)")
        )
      ).toBe(0);
    })
  ));

it("keeps Memory and Dashboard owner construction independent of read scope and refuses unverified sensitive effects", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture({
        scopes: ["write", "dashboard"],
        lifetimeDays: 7,
      });
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const response = yield* wait(
        mcpFixture({
          retryKey: Option.none(),
          send: fixture.send,
          bearer: token.access_token,
          method: "tools/call",
          name: "operations.executeAtomicBatch",
          args: {
            payload: {
              calls: [
                {
                  callId: "20000000-0000-4000-8000-000000000001",
                  operation: "memory.remember",
                  input: { payload: { text: "I plan my monthly spending in COP." } },
                },
                {
                  callId: "20000000-0000-4000-8000-000000000002",
                  operation: "dashboard.initializeDashboard",
                  input: {},
                },
              ],
            },
          },
        })
      );
      expect(yield* wait(response.json())).toMatchObject({ result: { isError: false } });
      const memoryId = yield* wait(
        fixture.db.prepare("SELECT id FROM memories").first<string>("id")
      );
      expect(memoryId).not.toBeNull();
      const refused = yield* wait(
        mcpFixture({
          retryKey: Option.none(),
          send: fixture.send,
          bearer: token.access_token,
          method: "tools/call",
          name: "memory.forget",
          args: { params: { id: memoryId ?? "" } },
        })
      );
      expect(yield* wait(refused.json())).toMatchObject({
        result: { isError: true, structuredContent: { error: { code: "user_action_required" } } },
      });
      expect(
        yield* wait(fixture.db.prepare("SELECT count(*) FROM memories").first<number>("count(*)"))
      ).toBe(1);
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM (SELECT user_id,document_json,revision FROM user_documents WHERE kind='dashboard') AS dashboard_documents"
            )
            .first<number>("count(*)")
        )
      ).toBe(1);
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit WHERE outcome = 'accepted' AND oauth_connection_id = ?"
            )
            .bind(fixture.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(2);
    })
  ));

it("fails Memory batches closed when owner inference construction is unavailable without denying unrelated mutations", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture({
        scopes: ["write"],
        lifetimeDays: 7,
      });
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      fixture.disableInference();
      const response = yield* wait(
        mcpFixture({
          retryKey: Option.none(),
          send: fixture.send,
          bearer: token.access_token,
          method: "tools/call",
          name: "operations.executeAtomicBatch",
          args: {
            payload: {
              calls: [
                transactionChildren[0],
                {
                  ...transactionChildren[1],
                  operation: "memory.remember",
                  input: { payload: { text: "I plan monthly spending." } },
                },
              ],
            },
          },
        })
      );
      expect(yield* wait(response.json())).toMatchObject({
        result: { isError: true, structuredContent: { error: { code: "unavailable" } } },
      });
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
        )
      ).toBe(0);
      expect(
        yield* wait(fixture.db.prepare("SELECT count(*) FROM memories").first<number>("count(*)"))
      ).toBe(0);
      const sensitive = yield* wait(
        mcpFixture({
          retryKey: Option.none(),
          send: fixture.send,
          bearer: token.access_token,
          method: "tools/call",
          name: "operations.executeAtomicBatch",
          args: {
            payload: {
              calls: [
                transactionChildren[0],
                {
                  ...transactionChildren[1],
                  operation: "memory.forget",
                  input: { params: { id: "30000000-0000-4000-8000-000000000001" } },
                },
              ],
            },
          },
        })
      );
      expect(yield* wait(sensitive.json())).toMatchObject({
        result: {
          isError: true,
          structuredContent: {
            error: { code: "user_action_required", failedCallIndex: 1, operation: "memory.forget" },
          },
        },
      });
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT operation, outcome FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit"
            )
            .all()
        )
      ).toMatchObject({ results: [{ operation: "memory.forget", outcome: "rejected" }] });
      const ordinary = yield* wait(
        mcpFixture({
          retryKey: Option.none(),
          send: fixture.send,
          bearer: token.access_token,
          method: "tools/call",
          name: "transactions.createTransaction",
          args: transactionArguments,
        })
      );
      expect(yield* wait(ordinary.json())).toMatchObject({ result: { isError: false } });
    })
  ));

it("reports interruption after a committed OAuth mutation without undoing or retrying its protected effects", () => {
  const controller = new AbortController();
  return Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture({
        scopes: ["write"],
        lifetimeDays: 7,
      });
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const committed = Promise.withResolvers<void>();
      fixture.interceptQueryResponse(() => {
        committed.resolve();
        controller.abort();
        return Promise.resolve(new Response("interrupted-delivery", { status: 200 }));
      });
      yield* wait(
        expect(
          mcpFixture({
            retryKey: Option.none(),
            send: (path, init) => fixture.send(path, { ...init, signal: controller.signal }),
            bearer: token.access_token,
            method: "tools/call",
            name: "transactions.createTransaction",
            args: transactionArguments,
          })
        ).rejects.toThrow("All fibers interrupted without error")
      );
      yield* wait(committed.promise);
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
        )
      ).toBe(1);
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit WHERE outcome = 'accepted' AND oauth_connection_id = ?"
            )
            .bind(fixture.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(1);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM canonical_request_leases")
            .first<number>("count(*)")
        )
      ).toBe(0);
    })
  );
});

it("shares bounded mutation concurrency across OAuth credentials for the same User before scheduling another coordinator unit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture({
        scopes: ["write"],
        lifetimeDays: 7,
      });
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const rotated = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait(
          (yield* wait(
            refreshFixture({ ...fixture, refresh: token.refresh_token, scope: Option.none() })
          )).json()
        )
      );
      const ready = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let admitted = 0;
      fixture.interceptQueryResponse(({ response }) => {
        admitted += 1;
        if (admitted === 2) ready.resolve();
        return release.promise.then(() => response);
      });
      const invoke = (bearer: string): Promise<Response> =>
        mcpFixture({
          retryKey: Option.none(),
          send: fixture.send,
          bearer,
          method: "tools/call",
          name: "transactions.createTransaction",
          args: transactionArguments,
        });
      const pending = [invoke(token.access_token), invoke(rotated.access_token)];
      yield* wait(ready.promise);
      const denied = yield* wait(invoke(rotated.access_token));
      expect(yield* wait(denied.json())).toMatchObject({
        result: {
          isError: true,
          structuredContent: { error: { code: "rate_limited", retryAfterSeconds: 1 } },
        },
      });
      expect(admitted).toBe(2);
      release.resolve();
      for (const response of yield* wait(Promise.all(pending))) {
        expect(yield* wait(response.json())).toMatchObject({ result: { isError: false } });
      }
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
        )
      ).toBe(2);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM canonical_request_leases")
            .first<number>("count(*)")
        )
      ).toBe(0);
    })
  ));

it("reuses Category and Budget owner behavior in one OAuth mutation unit with exact Money and independent accounting", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture({
        scopes: ["write"],
        lifetimeDays: 7,
      });
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const response = yield* wait(
        mcpFixture({
          retryKey: Option.none(),
          send: fixture.send,
          bearer: token.access_token,
          method: "tools/call",
          name: "operations.executeAtomicBatch",
          args: {
            payload: {
              calls: [
                {
                  ...transactionChildren[0],
                  operation: "categories.createKeywordRule",
                  input: { payload: { keyword: "Lunch", categoryId: categoryIds.restaurantes } },
                },
                {
                  ...transactionChildren[1],
                  operation: "budgets.createBudget",
                  input: {
                    payload: {
                      categoryId: categoryIds.restaurantes,
                      cap: { amount: "9007199254740993", currency: "COP" },
                    },
                  },
                },
              ],
            },
          },
        })
      );
      expect(yield* wait(response.json())).toMatchObject({
        result: {
          isError: false,
          structuredContent: {
            data: {
              results: [
                { operation: "categories.createKeywordRule" },
                {
                  operation: "budgets.createBudget",
                  output: { data: { cap: { amount: "9007199254740993", currency: "COP" } } },
                },
              ],
            },
          },
        },
      });
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM keyword_rules").first<number>("count(*)")
        )
      ).toBe(1);
      expect(
        yield* wait(fixture.db.prepare("SELECT count(*) FROM budgets").first<number>("count(*)"))
      ).toBe(1);
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit WHERE oauth_connection_id = ? AND outcome = 'accepted'"
            )
            .bind(fixture.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(2);
    })
  ));

it("refuses a foreign Transaction child after preparing an owned child without committing either transition", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture({
        scopes: ["write"],
        lifetimeDays: 7,
      });
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const created = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          result: Schema.Struct({
            structuredContent: Schema.Struct({
              data: Schema.Struct({ id: Schema.String, categoryId: Schema.String }),
            }),
          }),
        })
      )(
        yield* wait(
          (yield* wait(
            mcpFixture({
              retryKey: Option.none(),
              send: fixture.send,
              bearer: token.access_token,
              method: "tools/call",
              name: "transactions.createTransaction",
              args: transactionArguments,
            })
          )).json()
        )
      );
      yield* sessionFor({ db: fixture.db, index: 2 });
      const foreignId = "30000000-0000-4000-8000-000000000001";
      const current = DateTime.formatIso(yield* DateTime.now);
      yield* wait(
        fixture.db
          .prepare(
            "INSERT INTO transactions (id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms) VALUES (?,?,'15000','COP','outflow',?,CAST(round(unixepoch(?,'subsec')*1000) AS INTEGER),CAST(round(unixepoch(?,'subsec')*1000) AS INTEGER))"
          )
          .bind(
            foreignId,
            "20000000-0000-4000-8000-000000000001",
            created.result.structuredContent.data.categoryId,
            current,
            current
          )
          .run()
      );
      const response = yield* wait(
        mcpFixture({
          retryKey: Option.none(),
          send: fixture.send,
          bearer: token.access_token,
          method: "tools/call",
          name: "operations.executeAtomicBatch",
          args: {
            payload: {
              calls: [
                transactionChildren[0],
                {
                  ...transactionChildren[1],
                  operation: "transactions.linkTransactions",
                  input: {
                    payload: {
                      firstTransactionId: created.result.structuredContent.data.id,
                      secondTransactionId: foreignId,
                    },
                  },
                },
              ],
            },
          },
        })
      );
      expect(yield* wait(response.json())).toMatchObject({
        result: {
          isError: true,
          structuredContent: {
            error: {
              code: "not_found",
              failedCallIndex: 1,
              operation: "transactions.linkTransactions",
            },
            next: [],
          },
        },
      });
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
        )
      ).toBe(2);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM reconciled_transactions")
            .first<number>("count(*)")
        )
      ).toBe(0);
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit WHERE oauth_connection_id = ? AND outcome = 'accepted'"
            )
            .bind(fixture.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(1);
    })
  ));

it("links and unlinks exact owned Transactions through ordinary OAuth mutations without deleting originals or repeating accounting", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture({
        scopes: ["write"],
        lifetimeDays: 7,
      });
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const created = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          result: Schema.Struct({
            structuredContent: Schema.Struct({
              data: Schema.Struct({
                results: Schema.Tuple([
                  Schema.Struct({
                    output: Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }),
                  }),
                  Schema.Struct({
                    output: Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }),
                  }),
                ]),
              }),
            }),
          }),
        })
      )(
        yield* wait(
          (yield* wait(
            mcpFixture({
              retryKey: Option.none(),
              send: fixture.send,
              bearer: token.access_token,
              method: "tools/call",
              name: "operations.executeAtomicBatch",
              args: { payload: { calls: transactionChildren } },
            })
          )).json()
        )
      );
      const [first, second] = created.result.structuredContent.data.results;
      const args = {
        payload: {
          firstTransactionId: first.output.data.id,
          secondTransactionId: second.output.data.id,
        },
      };
      for (const name of ["transactions.linkTransactions", "transactions.unlinkTransactions"]) {
        const response = yield* wait(
          mcpFixture({
            retryKey: Option.none(),
            send: fixture.send,
            bearer: token.access_token,
            method: "tools/call",
            name,
            args,
          })
        );
        expect(yield* wait(response.json())).toMatchObject({ result: { isError: false } });
        expect(
          yield* wait(
            fixture.db
              .prepare("SELECT count(*) FROM reconciled_transactions")
              .first<number>("count(*)")
          )
        ).toBe(name === "transactions.linkTransactions" ? 2 : 0);
      }
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
        )
      ).toBe(2);
      expect(
        yield* wait(
          fixture.db.prepare("SELECT count(*) FROM source_attestations").first<number>("count(*)")
        )
      ).toBe(2);
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit WHERE oauth_connection_id = ? AND outcome = 'accepted'"
            )
            .bind(fixture.connectionId)
            .first<number>("count(*)")
        )
      ).toBe(4);
    })
  ));

it.each(["single", "mixed"])(
  "rechecks credential expiration when an OAuth %s unit is prepared but its native commit has not executed",
  (unit) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* approvedFixture({
          scopes: ["write", "dashboard"],
          lifetimeDays: 7,
        });
        const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
          yield* wait((yield* wait(exchangeFixture(fixture))).json())
        );
        const held = fixture.holdMutationCommit();
        const pending =
          unit === "single"
            ? mcpFixture({
                retryKey: Option.none(),
                send: fixture.send,
                bearer: token.access_token,
                method: "tools/call",
                name: "transactions.createTransaction",
                args: transactionArguments,
              })
            : mcpFixture({
                retryKey: Option.none(),
                send: fixture.send,
                bearer: token.access_token,
                method: "tools/call",
                name: "operations.executeAtomicBatch",
                args: {
                  payload: {
                    calls: [
                      transactionChildren[0],
                      {
                        ...transactionChildren[1],
                        operation: "dashboard.initializeDashboard",
                        input: {},
                      },
                    ],
                  },
                },
              });
        yield* wait(held.waiting);
        const expiresAt = (yield* Clock.currentTimeMillis) + 20;
        yield* wait(
          fixture.db
            .prepare(
              "UPDATE oauth_credentials AS oauth_credentials SET expires_at_ms = ? WHERE kind='access'"
            )
            .bind(expiresAt)
            .run()
        );
        yield* Effect.sleep("30 millis");
        held.release();
        const response = yield* wait(pending);
        expect(yield* wait(response.json())).toMatchObject({ result: { isError: true } });
        expect(
          yield* wait(
            fixture.db.prepare("SELECT count(*) FROM transactions").first<number>("count(*)")
          )
        ).toBe(0);
        expect(
          yield* wait(
            fixture.db.prepare("SELECT count(*) FROM source_attestations").first<number>("count(*)")
          )
        ).toBe(0);
        expect(
          yield* wait(
            fixture.db
              .prepare(
                "SELECT count(*) FROM (SELECT user_id,document_json,revision FROM user_documents WHERE kind='dashboard') AS dashboard_documents"
              )
              .first<number>("count(*)")
          )
        ).toBe(0);
        expect(
          yield* wait(
            fixture.db
              .prepare(
                "SELECT count(*) FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit WHERE outcome = 'accepted'"
              )
              .first<number>("count(*)")
          )
        ).toBe(0);
      })
    )
);

it.each(["single", "mixed"])(
  "rechecks a prepared OAuth %s unit after grant revocation, Consent withdrawal and child-scope narrowing",
  (unit) =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (const withdrawn of ["grant", "consent", "scope"]) {
          const fixture = yield* approvedFixture({
            scopes: ["write", "dashboard"],
            lifetimeDays: 7,
          });
          const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
            yield* wait((yield* wait(exchangeFixture(fixture))).json())
          );
          const held = fixture.holdMutationCommit();
          const calls = [
            transactionChildren[0],
            { ...transactionChildren[1], operation: "dashboard.initializeDashboard", input: {} },
          ];

          const pending =
            unit === "single"
              ? mcpFixture({
                  retryKey: Option.none(),
                  send: fixture.send,
                  bearer: token.access_token,
                  method: "tools/call",
                  name: "transactions.createTransaction",
                  args: transactionArguments,
                })
              : mcpFixture({
                  retryKey: Option.none(),
                  send: fixture.send,
                  bearer: token.access_token,
                  method: "tools/call",
                  name: "operations.executeAtomicBatch",
                  args: { payload: { calls } },
                });
          yield* wait(held.waiting);
          if (withdrawn === "grant") {
            yield* wait(
              fixture.db
                .prepare("UPDATE oauth_connections SET revoked_at_ms = ? WHERE id = ?")
                .bind(yield* Clock.currentTimeMillis, fixture.connectionId)
                .run()
            );
          }
          if (withdrawn === "consent") yield* revokeFixtureConsent(fixture.db);
          if (withdrawn === "scope") {
            yield* wait(
              fixture.db
                .prepare(
                  "UPDATE oauth_credentials AS oauth_credentials SET scopes_json = ? WHERE kind='access'"
                )
                .bind(unit === "single" ? '["dashboard"]' : '["write"]')
                .run()
            );
          }
          held.release();
          const response = yield* wait(pending);
          yield* wait(held.settled);
          expect(yield* wait(response.json()), `${unit}: ${withdrawn}`).toMatchObject({
            result: { isError: true },
          });
          for (const table of [
            "transactions",
            "source_attestations",
            "(SELECT user_id,document_json,revision FROM user_documents WHERE kind='dashboard')",
          ]) {
            expect(
              yield* wait(
                fixture.db.prepare(`SELECT count(*) FROM ${table}`).first<number>("count(*)")
              ),
              table
            ).toBe(0);
          }
          expect(
            yield* wait(
              fixture.db
                .prepare(
                  "SELECT count(*) FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit WHERE outcome = 'accepted'"
                )
                .first<number>("count(*)")
            )
          ).toBe(0);
        }
      })
    )
);

it("rechecks immutable OAuth grant expiration at the protected mixed-batch commit even with an unexpired credential", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const expiresAt = (yield* Clock.currentTimeMillis) + 4000;
      const approvalClock = vi
        .spyOn(Date, "now")
        .mockReturnValue(expiresAt - 7 * 24 * 60 * 60 * 1000);
      const fixture = yield* approvedFixture({
        scopes: ["write", "dashboard"],
        lifetimeDays: 7,
      });
      approvalClock.mockRestore();
      yield* wait(
        fixture.db
          .prepare(
            "UPDATE oauth_connections AS oauth_codes SET code_expires_at_ms = ? WHERE code_digest IS NOT NULL "
          )
          .bind(expiresAt)
          .run()
      );
      const original = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait(
          (yield* wait(
            refreshFixture({ ...fixture, refresh: original.refresh_token, scope: Option.none() })
          )).json()
        )
      );
      yield* wait(
        fixture.db
          .prepare(
            "UPDATE oauth_credentials AS oauth_credentials SET expires_at_ms = ? WHERE kind='access'"
          )
          .bind(expiresAt + 60000)
          .run()
      );
      const held = fixture.holdMutationCommit();
      const pending = mcpFixture({
        retryKey: Option.none(),
        send: fixture.send,
        bearer: token.access_token,
        method: "tools/call",
        name: "operations.executeAtomicBatch",
        args: {
          payload: {
            calls: [
              transactionChildren[0],
              { ...transactionChildren[1], operation: "dashboard.initializeDashboard", input: {} },
            ],
          },
        },
      });
      yield* wait(held.waiting);
      yield* Effect.sleep(Math.max(0, expiresAt - (yield* Clock.currentTimeMillis)) + 20);
      held.release();
      const response = yield* wait(pending);
      yield* wait(held.settled);
      expect(yield* wait(response.json())).toMatchObject({
        error: { code: -32603, message: "Internal error" },
      });
      for (const table of [
        "transactions",
        "source_attestations",
        "(SELECT user_id,document_json,revision FROM user_documents WHERE kind='dashboard')",
      ]) {
        expect(
          yield* wait(
            fixture.db.prepare(`SELECT count(*) FROM ${table}`).first<number>("count(*)")
          ),
          table
        ).toBe(0);
      }
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit WHERE outcome = 'accepted'"
            )
            .first<number>("count(*)")
        )
      ).toBe(0);
    })
  ));
