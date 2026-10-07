import { allowancePeriod } from "../../src/core/quotas/operations";
import { categoryIds } from "../../src/core/categories/contract";
import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import {
  type FixtureHeaders,
  type Harness,
  type TestFailure,
  TokenFixture,
  approveAgain,
  approvedFixture,
  authorizationQuery,
  exchangeFixture,
  mcpFixture,
  nativeConfirmationCall,
  nativePeer,
  pendingBudgetDeletion,
  refreshFixture,
  wait,
} from "./oauth-ingress.test-fixture";

const explicitNativeAccept = { action: "accept", content: { confirm: true } };
afterEach(() => vi.restoreAllMocks());
const allowancePAT = (
  fixture: Readonly<{ send: Harness["send"]; headers: FixtureHeaders }>
): Effect.Effect<string, TestFailure | Schema.SchemaError> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const issued = yield* wait(
      fixture.send("/pats", {
        method: "POST",
        headers: fixture.headers,
        body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
          requestId: "10000000-0000-4000-8000-000000000005",
          grant: {
            recipientLabel: "Agente directo",
            scopes: ["read", "write"],
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
    return pat.data.bearer;
  });

const seedCanonicalConsumption = (
  db: D1Database,
  units: number
): Effect.Effect<void, TestFailure> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const period = allowancePeriod(DateTime.makeUnsafe(current));
    yield* wait(
      db.batch(
        Array.from({ length: units }, (_, index) =>
          db
            .prepare(
              "INSERT INTO commercial_allowance_consumptions VALUES (?,'canonical_call',?,?,?,1)"
            )
            .bind(
              "10000000-0000-4000-8000-000000000001",
              `seed-${index}`,
              DateTime.toEpochMillis(period.startsAt),
              current
            )
        )
      )
    );
  });

it("shares the canonical-call allowance between PAT ingress and OAuth MCP", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture({
        scopes: ["read", "write"],
        lifetimeDays: 7,
        auditMigration: true,
      });
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const patBearer = yield* allowancePAT(fixture);
      const direct = yield* wait(
        fixture.send("/categories", { headers: { authorization: `Bearer ${patBearer}` } })
      );
      expect(direct.status).toBe(200);
      expect(direct.headers.get("fidy-canonical-remaining")).toBe("49");
      const called = yield* wait(
        mcpFixture({
          retryKey: Option.none(),
          ...fixture,
          bearer: token.access_token,
          method: "tools/call",
          name: "categories.listCategories",
          args: {},
        })
      );
      expect(yield* wait(called.json())).toMatchObject({
        result: {
          isError: false,
          _meta: {
            "co.fidy/canonicalAllowance": {
              allowance: "canonical_call",
              limit: "50",
              remaining: "48",
            },
          },
        },
      });
      const inspected = yield* wait(
        mcpFixture({
          retryKey: Option.none(),
          ...fixture,
          bearer: token.access_token,
          method: "tools/call",
          name: "quota.getQuota",
          args: {},
        })
      );
      expect(yield* wait(inspected.json())).toMatchObject({
        result: { structuredContent: { data: { canonicalCalls: { consumed: 2, remaining: 48 } } } },
      });
    })
  ));

it("accounts OAuth mutation attempts and atomic batches once and replays across PAT and rotated credentials", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture({
        scopes: ["read", "write"],
        lifetimeDays: 7,
        auditMigration: true,
      });
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const patBearer = yield* allowancePAT(fixture);
      const args = {
        payload: { categoryId: categoryIds.mercado, cap: { amount: "1000", currency: "COP" } },
      };
      const invoke = (name: string, args: Schema.Json, retryKey?: Schema.Json): Promise<Response> =>
        mcpFixture({
          ...fixture,
          bearer: token.access_token,
          method: "tools/call",
          name,
          args,
          retryKey: Option.fromUndefinedOr(retryKey),
        });
      const created = yield* wait(invoke("budgets.createBudget", args, "budget-once"));
      const original = yield* wait(created.json());
      expect(original).toMatchObject({
        result: { isError: false, _meta: { "co.fidy/canonicalAllowance": { remaining: "49" } } },
      });
      const patReplay = yield* wait(
        fixture.send("/budgets", {
          method: "POST",
          headers: {
            authorization: `Bearer ${patBearer}`,
            "content-type": "application/json",
            "fidy-retry-key": "budget-once",
          },
          body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(args.payload),
        })
      );
      expect(patReplay.status).toBe(201);
      expect(patReplay.headers.get("fidy-canonical-remaining")).toBe("49");
      const rotated = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait(
          (yield* wait(
            refreshFixture({ ...fixture, refresh: token.refresh_token, scope: Option.none() })
          )).json()
        )
      );
      const replayed = yield* wait(
        mcpFixture({
          ...fixture,
          bearer: rotated.access_token,
          method: "tools/call",
          name: "budgets.createBudget",
          args,
          retryKey: Option.some("budget-once"),
        })
      );
      expect(yield* wait(replayed.json())).toEqual(original);
      const mismatch = yield* wait(
        invoke(
          "budgets.createBudget",
          { payload: { ...args.payload, cap: { amount: "2000", currency: "COP" } } },
          "budget-once"
        )
      );
      expect(yield* wait(mismatch.json())).toMatchObject({
        result: {
          isError: true,
          structuredContent: { error: { code: "validation_failed" } },
          _meta: { "co.fidy/canonicalAllowance": { remaining: "49" } },
        },
      });
      const failed = yield* wait(invoke("budgets.createBudget", args));
      expect(yield* wait(failed.json())).toMatchObject({
        result: { isError: true, _meta: { "co.fidy/canonicalAllowance": { remaining: "48" } } },
      });
      const batch = {
        payload: {
          calls: [
            {
              callId: "10000000-0000-4000-8000-000000000011",
              operation: "budgets.createBudget",
              input: {
                payload: {
                  categoryId: categoryIds.transporte,
                  cap: { amount: "2000", currency: "COP" },
                },
              },
            },
            {
              callId: "10000000-0000-4000-8000-000000000012",
              operation: "budgets.createBudget",
              input: {
                payload: {
                  categoryId: categoryIds.salud,
                  cap: { amount: "3000", currency: "COP" },
                },
              },
            },
          ],
        },
      };
      const batched = yield* wait(invoke("operations.executeAtomicBatch", batch, "batch-once"));
      expect(yield* wait(batched.json())).toMatchObject({
        result: { isError: false, _meta: { "co.fidy/canonicalAllowance": { remaining: "47" } } },
      });
      const repeat = yield* wait(invoke("operations.executeAtomicBatch", batch, "batch-once"));
      expect(yield* wait(repeat.json())).toMatchObject({
        result: { isError: false, _meta: { "co.fidy/canonicalAllowance": { remaining: "47" } } },
      });
      expect(
        yield* wait(fixture.db.prepare("SELECT count(*) FROM budgets").first<number>("count(*)"))
      ).toBe(3);
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM pat_audit WHERE oauth_credential_id IS NOT NULL AND operation = 'budgets.createBudget'"
            )
            .first<number>("count(*)")
        )
      ).toBe(6);
    })
  ));

it("refuses exhausted OAuth mutations and batches without partial effects across clients, grants and refresh", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture({
        scopes: ["read", "write"],
        lifetimeDays: 7,
        auditMigration: true,
      });
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      yield* seedCanonicalConsumption(fixture.db, 50);
      const rotated = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait(
          (yield* wait(
            refreshFixture({ ...fixture, refresh: token.refresh_token, scope: Option.none() })
          )).json()
        )
      );
      const again = yield* approveAgain(fixture);
      const replacement = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture({ ...fixture, body: again.body }))).json())
      );
      const query = yield* authorizationQuery(fixture.send);
      const clientBody = new URLSearchParams(fixture.body);
      clientBody.set("client_id", query.get("client_id") ?? "");
      const otherClient = yield* approveAgain({ ...fixture, body: clientBody });
      const other = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture({ ...fixture, body: otherClient.body }))).json())
      );
      for (const bearer of [
        token.access_token,
        rotated.access_token,
        replacement.access_token,
        other.access_token,
      ]) {
        const discovery = yield* wait(
          mcpFixture({ retryKey: Option.none(), ...fixture, bearer, method: "tools/list" })
        );
        expect(discovery.status).toBe(200);
        const query = yield* wait(
          mcpFixture({
            retryKey: Option.none(),
            ...fixture,
            bearer,
            method: "tools/call",
            name: "categories.listCategories",
            args: {},
          })
        );
        expect(yield* wait(query.json())).toMatchObject({
          result: {
            isError: true,
            structuredContent: { error: { code: "quota_exhausted", allowance: "canonical_call" } },
            _meta: { "co.fidy/canonicalAllowance": { remaining: "0" } },
          },
        });
      }
      const args = {
        payload: { categoryId: categoryIds.mercado, cap: { amount: "1000", currency: "COP" } },
      };
      for (const [name, input] of [
        ["budgets.createBudget", args],
        [
          "operations.executeAtomicBatch",
          {
            payload: {
              calls: [
                {
                  callId: "10000000-0000-4000-8000-000000000011",
                  operation: "budgets.createBudget",
                  input: args,
                },
              ],
            },
          },
        ],
      ] as const) {
        const refused = yield* wait(
          mcpFixture({
            retryKey: Option.none(),
            ...fixture,
            bearer: rotated.access_token,
            method: "tools/call",
            name,
            args: input,
          })
        );
        expect(yield* wait(refused.json())).toMatchObject({
          result: { isError: true, structuredContent: { error: { code: "quota_exhausted" } } },
        });
      }
      const inspection = yield* wait(
        mcpFixture({
          retryKey: Option.none(),
          ...fixture,
          bearer: other.access_token,
          method: "tools/call",
          name: "quota.getQuota",
          args: {},
        })
      );
      expect(yield* wait(inspection.json())).toMatchObject({
        result: {
          isError: false,
          structuredContent: { data: { canonicalCalls: { remaining: 0, consumed: 50 } } },
        },
      });
      expect(
        yield* wait(fixture.db.prepare("SELECT count(*) FROM budgets").first<number>("count(*)"))
      ).toBe(0);
    })
  ));

it("linearizes parallel PAT and OAuth mutation admission at the last Free canonical unit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture({
        scopes: ["read", "write"],
        lifetimeDays: 7,
        auditMigration: true,
      });
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const patBearer = yield* allowancePAT(fixture);
      yield* seedCanonicalConsumption(fixture.db, 49);
      const cap = { amount: "1000", currency: "COP" };
      const patBody = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
        categoryId: categoryIds.transporte,
        cap,
      });
      const [pat, oauth] = yield* wait(
        Promise.all([
          fixture.send("/budgets", {
            method: "POST",
            headers: { authorization: `Bearer ${patBearer}`, "content-type": "application/json" },
            body: patBody,
          }),
          mcpFixture({
            retryKey: Option.none(),
            ...fixture,
            bearer: token.access_token,
            method: "tools/call",
            name: "budgets.createBudget",
            args: { payload: { categoryId: categoryIds.mercado, cap } },
          }),
        ])
      );
      const result = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          result: Schema.Struct({ isError: Schema.Boolean, structuredContent: Schema.Json }),
        })
      )(yield* wait(oauth.json()));
      expect(Number(pat.ok) + Number(!result.result.isError)).toBe(1);
      const refusal = pat.ok ? result.result.structuredContent : yield* wait(pat.json());
      expect(refusal).toMatchObject({ error: { code: "quota_exhausted" } });
      expect(
        yield* wait(fixture.db.prepare("SELECT count(*) FROM budgets").first<number>("count(*)"))
      ).toBe(1);
      const remaining = yield* wait(
        mcpFixture({
          retryKey: Option.none(),
          ...fixture,
          bearer: token.access_token,
          method: "tools/call",
          name: "quota.getQuota",
          args: {},
        })
      );
      expect(yield* wait(remaining.json())).toMatchObject({
        result: { structuredContent: { data: { canonicalCalls: { consumed: 50, remaining: 0 } } } },
      });
    })
  ));

it("resets the shared OAuth and PAT allowance at the exact Bogota month boundary without recharging live retries", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const instant = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-01T04:59:59.999Z"));
      const clock = vi.spyOn(Date, "now").mockReturnValue(instant);
      const fixture = yield* approvedFixture({
        scopes: ["read", "write"],
        lifetimeDays: 7,
        auditMigration: true,
      });
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const patBearer = yield* allowancePAT(fixture);
      yield* seedCanonicalConsumption(fixture.db, 49);
      const call = (): Promise<Response> =>
        mcpFixture({
          ...fixture,
          bearer: token.access_token,
          method: "tools/call",
          name: "categories.listCategories",
          args: {},
          retryKey: Option.some("month-boundary"),
        });
      const last = yield* wait(call());
      expect(yield* wait(last.json())).toMatchObject({
        result: {
          isError: false,
          _meta: {
            "co.fidy/canonicalAllowance": { remaining: "0", resetsAt: "2026-11-01T05:00:00.000Z" },
          },
        },
      });
      const refused = yield* wait(
        mcpFixture({
          retryKey: Option.none(),
          ...fixture,
          bearer: token.access_token,
          method: "tools/call",
          name: "categories.listCategories",
          args: {},
        })
      );
      expect(yield* wait(refused.json())).toMatchObject({
        result: {
          structuredContent: {
            error: { code: "quota_exhausted", resetsAt: "2026-11-01T05:00:00.000Z" },
          },
        },
      });
      clock.mockReturnValue(instant + 1);
      const replayed = yield* wait(call());
      expect(yield* wait(replayed.json())).toMatchObject({
        result: {
          isError: false,
          _meta: {
            "co.fidy/canonicalAllowance": { remaining: "50", resetsAt: "2026-12-01T05:00:00.000Z" },
          },
        },
      });
      const direct = yield* wait(
        fixture.send("/categories", { headers: { authorization: `Bearer ${patBearer}` } })
      );
      expect(direct.status).toBe(200);
      expect(direct.headers.get("fidy-canonical-remaining")).toBe("49");
      const inspected = yield* wait(
        mcpFixture({
          retryKey: Option.none(),
          ...fixture,
          bearer: token.access_token,
          method: "tools/call",
          name: "quota.getQuota",
          args: {},
        })
      );
      expect(yield* wait(inspected.json())).toMatchObject({
        result: { structuredContent: { data: { canonicalCalls: { remaining: 49, consumed: 1 } } } },
      });
    })
  ));

it("keeps Trial OAuth calls commercially uncapped while reporting independent security refusal", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      yield* seedCanonicalConsumption(fixture.db, 50);
      const current = yield* Clock.currentTimeMillis;
      yield* wait(
        fixture.db
          .prepare("INSERT INTO trial_periods VALUES (?,?,?)")
          .bind("10000000-0000-4000-8000-000000000001", current - 1, current - 1 + 604800000)
          .run()
      );
      const called = yield* wait(
        mcpFixture({
          retryKey: Option.none(),
          ...fixture,
          bearer: token.access_token,
          method: "tools/call",
          name: "categories.listCategories",
          args: {},
        })
      );
      expect(yield* wait(called.json())).toMatchObject({
        result: {
          isError: false,
          _meta: { "co.fidy/canonicalAllowance": { limit: "uncapped", remaining: "uncapped" } },
        },
      });
      yield* wait(
        fixture.db
          .prepare(
            "INSERT INTO canonical_request_buckets VALUES (?,?) ON CONFLICT(subject) DO UPDATE SET virtual_at_ms = excluded.virtual_at_ms"
          )
          .bind("user:10000000-0000-4000-8000-000000000001", current + 60000)
          .run()
      );
      const refused = yield* wait(
        mcpFixture({
          retryKey: Option.none(),
          ...fixture,
          bearer: token.access_token,
          method: "tools/call",
          name: "categories.listCategories",
          args: {},
        })
      );
      expect(yield* wait(refused.json())).toMatchObject({
        result: {
          isError: true,
          structuredContent: { error: { code: "rate_limited", retryAfterSeconds: 1 } },
          _meta: { "co.fidy/canonicalAllowance": { remaining: "uncapped" } },
        },
      });
    })
  ));

it("charges native confirmation once and prevents continuation references from exempting unrelated canonical work", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* pendingBudgetDeletion();
      const inspect = (): Promise<Response> =>
        mcpFixture({
          retryKey: Option.none(),
          ...fixture,
          method: "tools/call",
          name: "quota.getQuota",
          args: {},
        });
      expect(yield* wait((yield* wait(inspect())).json())).toMatchObject({
        result: { structuredContent: { data: { canonicalCalls: { consumed: 2 } } } },
      });
      expect(yield* wait((yield* wait(fixture.call(explicitNativeAccept))).json())).toMatchObject({
        result: { isError: false, _meta: { "co.fidy/canonicalAllowance": { remaining: "48" } } },
      });
      expect(yield* wait((yield* wait(fixture.call(explicitNativeAccept))).json())).toMatchObject({
        result: { isError: true, _meta: { "co.fidy/canonicalAllowance": { remaining: "48" } } },
      });
      const unrelated = yield* wait(
        nativeConfirmationCall({
          fixture,
          params: {
            name: "categories.listCategories",
            arguments: {},
            requestState: fixture.reference,
            inputResponses: { review: explicitNativeAccept },
          },
          name: "categories.listCategories",
        })
      );
      expect(yield* wait(unrelated.json())).toMatchObject({
        result: { isError: false, _meta: { "co.fidy/canonicalAllowance": { remaining: "47" } } },
      });
      expect(
        yield* wait(fixture.db.prepare("SELECT count(*) FROM budgets").first<number>("count(*)"))
      ).toBe(0);
    })
  ));

it("shares one retry admission during parallel PAT and OAuth mutations without repeating a domain effect", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture({
        scopes: ["read", "write"],
        lifetimeDays: 7,
        auditMigration: true,
      });
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const patBearer = yield* allowancePAT(fixture);
      yield* seedCanonicalConsumption(fixture.db, 49);
      const payload = { categoryId: categoryIds.mercado, cap: { amount: "1000", currency: "COP" } };
      const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(payload);
      const direct = (): Promise<Response> =>
        fixture.send("/budgets", {
          method: "POST",
          headers: {
            authorization: `Bearer ${patBearer}`,
            "content-type": "application/json",
            "fidy-retry-key": "parallel-once",
          },
          body,
        });
      const [pat, oauth] = yield* wait(
        Promise.all([
          direct(),
          mcpFixture({
            ...fixture,
            bearer: token.access_token,
            method: "tools/call",
            name: "budgets.createBudget",
            args: { payload },
            retryKey: Option.some("parallel-once"),
          }),
        ])
      );
      const reply = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ result: Schema.Struct({ isError: Schema.Boolean }) })
      )(yield* wait(oauth.json()));
      expect(pat.ok || !reply.result.isError).toBe(true);
      const replay = yield* wait(direct());
      expect(replay.status).toBe(201);
      expect(replay.headers.get("fidy-canonical-remaining")).toBe("0");
      expect(
        yield* wait(fixture.db.prepare("SELECT count(*) FROM budgets").first<number>("count(*)"))
      ).toBe(1);
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT sum(units) FROM commercial_allowance_consumptions WHERE allowance = 'canonical_call'"
            )
            .first<number>("sum(units)")
        )
      ).toBe(50);
    })
  ));

it("rechecks live OAuth capabilities and revocation before disclosing retained financial retry results", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture({
        scopes: ["read", "write"],
        lifetimeDays: 7,
        auditMigration: true,
      });
      const token = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture(fixture))).json())
      );
      const args = {
        payload: { categoryId: categoryIds.mercado, cap: { amount: "1000", currency: "COP" } },
      };
      const created = yield* wait(
        mcpFixture({
          ...fixture,
          bearer: token.access_token,
          method: "tools/call",
          name: "budgets.createBudget",
          args,
          retryKey: Option.some("private-budget"),
        })
      );
      const result = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          result: Schema.Struct({
            structuredContent: Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }),
          }),
        })
      )(yield* wait(created.json()));
      const peer = yield* nativePeer({ fixture, userIndex: 2 });
      const separate = yield* wait(
        mcpFixture({
          ...fixture,
          bearer: peer.bearer,
          method: "tools/call",
          name: "budgets.createBudget",
          args,
          retryKey: Option.some("private-budget"),
        })
      );
      const peerResult = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          result: Schema.Struct({
            structuredContent: Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }),
          }),
        })
      )(yield* wait(separate.json()));
      expect(peerResult.result.structuredContent.data.id).not.toBe(
        result.result.structuredContent.data.id
      );
      const standing = yield* wait(
        mcpFixture({
          retryKey: Option.none(),
          ...fixture,
          bearer: peer.bearer,
          method: "tools/call",
          name: "quota.getQuota",
          args: {},
        })
      );
      expect(yield* wait(standing.json())).toMatchObject({
        result: { structuredContent: { data: { canonicalCalls: { consumed: 1, remaining: 49 } } } },
      });
      const readonlyGrant = yield* approveAgain(fixture);
      const readonlyToken = yield* Schema.decodeUnknownEffect(TokenFixture)(
        yield* wait((yield* wait(exchangeFixture({ ...fixture, body: readonlyGrant.body }))).json())
      );
      const refused = yield* wait(
        mcpFixture({
          ...fixture,
          bearer: readonlyToken.access_token,
          method: "tools/call",
          name: "budgets.createBudget",
          args,
          retryKey: Option.some("private-budget"),
        })
      );
      const text = yield* wait(refused.text());
      expect(text).not.toContain(result.result.structuredContent.data.id);
      expect(text).toContain('"error"');
      yield* wait(
        fixture.send("/web/oauth/revoke", {
          method: "POST",
          headers: fixture.headers,
          body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))({
            connectionId: fixture.connectionId,
          }),
        })
      );
      const revoked = yield* wait(
        mcpFixture({
          ...fixture,
          bearer: token.access_token,
          method: "tools/call",
          name: "budgets.createBudget",
          args,
          retryKey: Option.some("private-budget"),
        })
      );
      expect(revoked.status).toBe(401);
      expect(yield* wait(revoked.text())).not.toContain(result.result.structuredContent.data.id);
      expect(
        yield* wait(fixture.db.prepare("SELECT count(*) FROM budgets").first<number>("count(*)"))
      ).toBe(2);
    })
  ));
