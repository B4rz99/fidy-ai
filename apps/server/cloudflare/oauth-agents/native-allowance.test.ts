import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, DateTime, Effect, Schema } from "effect";
import { expect } from "vitest";
import { allowancePeriod } from "../../src/core/quotas/operations";
import { oauthIssuer, oauthResource } from "../../src/shell/oauth-agents/contract";
import { alice, category } from "../financial-user-store.test-fixture";
import { native } from "../user-store.test-fixture";
import { nativeGrant, protocolFor, tokenPair } from "./native-grant.test-fixture";

const mixedClients = Effect.gen(function* () {
  const fixture = yield* nativeGrant;
  const { session, owner, runtime, credential, exchange, client_id } = fixture;
  const issued = yield* session("/pats", alice, {
    requestId: "816551ab-a25e-4167-b87c-f7cc68890071",
    grant: {
      recipientLabel: "CLI",
      scopes: ["write", "read"],
      lifetimeDays: 7,
      reviewExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(owner.now + 604800000)),
    },
  });
  expect(issued.status).toBe(200);
  const {
    data: { bearer },
  } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ data: Schema.Struct({ bearer: Schema.String }) })
  )(yield* native(() => issued.json()));
  const protocol = protocolFor(runtime);
  const rotated = yield* exchange({
    client_id,
    resource: oauthResource,
    grant_type: "refresh_token",
    refresh_token: credential.refresh_token,
  });
  expect(rotated.status).toBe(200);
  const pair = yield* Schema.decodeUnknownEffect(tokenPair)(yield* native(() => rotated.json()));
  const payload = { categoryId: category, cap: { amount: "1000", currency: "COP" } };
  const post = (key: string): ReturnType<typeof session> =>
    native(() =>
      runtime.dispatchFetch(oauthIssuer + "/budgets", {
        method: "POST",
        headers: {
          authorization: "Bearer " + bearer,
          "content-type": "application/json",
          "cf-connecting-ip": "192.0.2.49",
          "Fidy-Retry-Key": key,
        },
        body: JSON.stringify(payload),
      })
    );
  const invoke = (token: string, retryKey: string): ReturnType<typeof session> =>
    protocol(token, "tools/call", { name: "budgets.createBudget", args: { payload }, retryKey });
  return { owner, credential, pair, post, invoke, protocol };
});
const seedLastUnit = Effect.fn(function* (owner: Effect.Success<typeof nativeGrant>["owner"]) {
  const current = yield* Clock.currentTimeMillis;
  const starts = DateTime.toEpochMillis(allowancePeriod(DateTime.makeUnsafe(current)).startsAt);
  yield* owner.exec(
    "WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<49) INSERT INTO commercial_allowance_consumptions SELECT ?,'canonical_call','fixture-'||n,?,?,1 FROM numbers",
    alice.user,
    starts,
    current
  );
});
it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "shares one retry across concurrent PAT and MCP mutations and a rotated credential",
    () =>
      Effect.gen(function* () {
        const { owner, credential, pair, post, invoke } = yield* mixedClients;
        yield* seedLastUnit(owner);
        const [direct, agent] = yield* Effect.all(
          [post("one-budget"), invoke(credential.access_token, "one-budget")],
          { concurrency: 2 }
        );
        expect(direct.status).toBe(201);
        expect(direct.headers.get("fidy-canonical-remaining")).toBe("0");
        const first = yield* native(() => agent.json());
        expect(first).toMatchObject({
          result: { isError: false, _meta: { "co.fidy/canonicalAllowance": { remaining: "0" } } },
        });
        expect(
          Schema.is(Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }))(
            yield* native(() => direct.json())
          )
        ).toBe(true);
        const retained = yield* post("one-budget");
        expect(retained.status).toBe(201);
        expect(retained.headers.get("fidy-canonical-remaining")).toBe("0");
        expect(
          yield* owner.exec(
            "SELECT sum(units) AS n FROM commercial_allowance_consumptions WHERE allowance='canonical_call'"
          )
        ).toEqual([{ n: 50 }]);
        const replay = yield* invoke(pair.access_token, "one-budget");
        expect(yield* native(() => replay.json())).toEqual(first);
        expect(yield* owner.exec("SELECT count(*) AS n FROM budgets")).toEqual([{ n: 1 }]);
      })
  );
  test.effect(
    "linearizes PAT and OAuth at the last Free canonical unit without a partial second effect",
    () =>
      Effect.gen(function* () {
        const { owner, pair, post, invoke, protocol } = yield* mixedClients;
        yield* seedLastUnit(owner);
        const [direct, agent] = yield* Effect.all(
          [post("direct-budget"), invoke(pair.access_token, "oauth-budget")],
          { concurrency: 2 }
        );
        const response = yield* native(() => agent.json());
        if (direct.status === 201) {
          expect(response).toMatchObject({
            result: { isError: true, structuredContent: { error: { code: "quota_exhausted" } } },
          });
        } else {
          expect(direct.status).toBe(429);
          expect(yield* native(() => direct.json())).toMatchObject({
            error: { code: "quota_exhausted" },
          });
          expect(response).toMatchObject({ result: { isError: false } });
        }
        const standing = yield* protocol(pair.access_token, "tools/call", {
          name: "quota.getQuota",
          args: {},
        });
        expect(yield* native(() => standing.json())).toMatchObject({
          result: {
            structuredContent: { data: { canonicalCalls: { consumed: 50, remaining: 0 } } },
          },
        });
        expect(direct.headers.get("fidy-canonical-remaining")).toBe("0");
        expect(yield* owner.exec("SELECT count(*) AS n FROM budgets")).toEqual([{ n: 1 }]);
      })
  );
});
