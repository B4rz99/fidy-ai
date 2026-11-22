import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect, Predicate, Schema } from "effect";
import { expect } from "vitest";
import { oauthIssuer, oauthPaths, oauthResource } from "../../src/shell/oauth-agents/contract";
import { alice, bob } from "../financial-user-store.test-fixture";
import { nativeGrant, protocolFor, tokenPair } from "./native-grant.test-fixture";
import { native, nativeOAuthPlatform } from "../user-store.test-fixture";

const responseText = (response: Pick<Response, "text">): Effect.Effect<string> =>
  native(() => response.text());

const callTool = Effect.fn(function* (
  protocol: ReturnType<typeof protocolFor>,
  token: string,
  name: string
) {
  const next = yield* protocol(token, "tools/call", {
    name,
    args: name === "categories.listCategories" ? {} : { query: {} },
  });

  expect(next.status).toBe(200);
  expect(yield* native(() => next.json())).toMatchObject({ result: { isError: false } });
});

const subscription = (
  runtime: Parameters<typeof protocolFor>[0],
  token: string
): ReturnType<ReturnType<typeof protocolFor>> =>
  native(() =>
    runtime.dispatchFetch(oauthResource, {
      method: "POST",
      headers: {
        "cf-connecting-ip": "192.0.2.75",
        authorization: "Bearer " + token,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "subscriptions/listen",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "subscriptions/listen",
        params: {
          notifications: { toolsListChanged: true },
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    })
  );

const holdSubscription = Effect.fn(function* (subscribe: () => ReturnType<typeof subscription>) {
  const reply = yield* subscribe();
  expect(reply.status).toBe(200);
  const reader = reply.body?.getReader();

  if (reader === undefined) return yield* Effect.die("Missing resident stream");

  return yield* Effect.acquireRelease(
    Effect.gen(function* () {
      const ack = yield* native(() => reader.read());

      if (!Predicate.isUint8Array(ack.value)) {
        return yield* Effect.die("Missing MCP acknowledgement");
      }

      expect(new TextDecoder().decode(ack.value)).toContain("subscriptions/acknowledged");

      return reader;
    }),
    (stream) => native(() => stream.cancel())
  );
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "refuses substituted token purpose, credential scope, client and resource without spending a refresh generation",
    () =>
      Effect.gen(function* () {
        const { runtime, owner, client_id, credential, exchange, connectionId, session } =
          yield* nativeGrant;

        const input = {
          client_id,
          resource: oauthResource,
          grant_type: "refresh_token",
          refresh_token: credential.refresh_token,
        };

        yield* Effect.forEach(
          [
            { ...input, refresh_token: credential.access_token },
            { ...input, client_id: "20000000-0000-4000-8000-000000000051" },
            { ...input, resource: "https://other.example/mcp" },
            { ...input, scope: "dashboard" },
          ],
          Effect.fnUntraced(function* (fields) {
            const bad = yield* exchange(fields);
            expect(bad.status).toBe(400);
            expect(yield* responseText(bad)).not.toContain(credential.refresh_token);
          }),
          { discard: true }
        );

        const wrong = yield* protocolFor(runtime)(credential.refresh_token, "tools/list");
        expect(wrong.status).toBe(401);
        expect(
          yield* owner.exec(
            "SELECT count(*) AS n FROM oauth_credentials WHERE consumed_at_ms IS NOT NULL"
          )
        ).toEqual([{ n: 0 }]);
        yield* owner.exec(
          "UPDATE web_sessions SET created_at_ms=created_at_ms-600001,fresh_until_ms=fresh_until_ms-600001,hard_expires_at_ms=hard_expires_at_ms-600001"
        );
        expect((yield* session(oauthPaths.connections, alice)).status).toBe(200);
        expect((yield* session(oauthPaths.revoke, alice, { connectionId })).status).toBe(403);
        yield* owner.exec(
          "UPDATE oauth_connections SET scopes_json=? WHERE id=?",
          '["read"]',
          connectionId
        );
        const obsolete = yield* protocolFor(runtime)(credential.access_token, "tools/list");
        expect(obsolete.status).toBe(401);
        yield* native(() => obsolete.text());
        expect((yield* exchange({ ...input, scope: "write" })).status).toBe(400);
        const allowed = yield* exchange({ ...input, scope: "read" });
        expect(allowed.status).toBe(200);
      })
  );
  test.effect(
    "releases eight occupied MCP slots at the original credential expiry and accepts a new resident",
    () =>
      Effect.gen(function* () {
        const { runtime, credential, owner } = yield* nativeGrant;

        const current = yield* Clock.currentTimeMillis,
          originalExpiry = current + 4000;

        yield* owner.exec(
          "UPDATE oauth_credentials SET expires_at_ms=? WHERE kind='access'",
          originalExpiry
        );

        const subscribe = (): ReturnType<typeof subscription> =>
          subscription(runtime, credential.access_token);

        const leases = yield* Effect.forEach(Array.from({ length: 8 }), () =>
          holdSubscription(subscribe)
        );

        const refused = yield* subscribe();
        expect(refused.status).toBe(503);
        yield* native(() => refused.arrayBuffer());
        const first = leases[0];

        if (first === undefined) return yield* Effect.die("Missing first resident");
        yield* owner.exec(
          "UPDATE oauth_credentials SET expires_at_ms=? WHERE kind='access'",
          current + 60000
        );
        expect((yield* native(() => first.read()).pipe(Effect.timeout("10 seconds"))).done).toBe(
          true
        );
        yield* holdSubscription(subscribe);
      })
  );
  test.effect(
    "rolls back local OAuth revocation when its immutable Consent evidence cannot be retained",
    () =>
      Effect.gen(function* () {
        const { owner, credential, connectionId, runtime, session } = yield* nativeGrant;

        const facts = (): ReturnType<typeof owner.exec> =>
          owner.exec(
            "SELECT revoked_at_ms IS NOT NULL AS revoked,(SELECT count(*) FROM consent_history WHERE record_type='oauth_user_revocation' AND connection_id=c.id) AS decisions FROM oauth_connections c WHERE id=?",
            connectionId
          );

        yield* owner.exec(
          "CREATE TRIGGER withhold_decision BEFORE INSERT ON consent_history WHEN NEW.record_type='oauth_user_revocation' BEGIN SELECT RAISE(IGNORE); END"
        );
        expect((yield* session(oauthPaths.revoke, alice, { connectionId })).status).toBe(503);
        expect(yield* facts()).toEqual([{ revoked: 0, decisions: 0 }]);
        expect((yield* protocolFor(runtime)(credential.access_token, "tools/list")).status).toBe(
          200
        );
        yield* owner.exec("DROP TRIGGER withhold_decision");
        expect((yield* session(oauthPaths.revoke, alice, { connectionId })).status).toBe(200);
        expect(yield* facts()).toEqual([{ revoked: 1, decisions: 1 }]);
        expect((yield* protocolFor(runtime)(credential.access_token, "tools/list")).status).toBe(
          401
        );
      })
  );

  test.effect.each(["browser revocation", "refresh replay"] as const)(
    "closes a mounted MCP subscription after %s",
    (reason) =>
      Effect.gen(function* () {
        const { runtime, credential, connectionId, client_id, exchange, session } =
          yield* nativeGrant;

        const response = yield* subscription(runtime, credential.access_token);
        expect(response.status).toBe(200);
        const reader = response.body?.getReader();

        if (reader === undefined) return yield* Effect.die("Missing MCP subscription");
        const first = yield* native(() => reader.read());

        if (!Predicate.isUint8Array(first.value)) {
          return yield* Effect.die("Missing MCP event bytes");
        }

        expect(new TextDecoder().decode(first.value)).toContain("subscriptions/acknowledged");

        const close = {
          "browser revocation": Effect.gen(function* () {
            const revoked = yield* session(oauthPaths.revoke, alice, { connectionId });
            expect(revoked.status).toBe(200);
            yield* responseText(revoked);
          }),
          "refresh replay": Effect.gen(function* () {
            const input = {
              client_id,
              resource: oauthResource,
              grant_type: "refresh_token",
              refresh_token: credential.refresh_token,
            };

            const rotated = yield* exchange(input);
            expect(rotated.status).toBe(200);
            yield* responseText(rotated);
            const replay = yield* exchange(input);
            expect(replay.status).toBe(400);
            yield* responseText(replay);
          }),
        };

        yield* close[reason];

        const closed = yield* Effect.tryPromise(() => reader.read()).pipe(
          Effect.match({ onSuccess: (chunk) => chunk.done, onFailure: () => true })
        );

        expect(closed).toBe(true);
      })
  );

  test.effect(
    "publishes OAuth discovery and the MCP challenge before any client or User exists",
    () =>
      Effect.gen(function* () {
        const create = yield* nativeOAuthPlatform,
          runtime = yield* create();

        const request = (
          path: string
        ): Effect.Effect<Awaited<ReturnType<typeof runtime.dispatchFetch>>> =>
          native(() =>
            runtime.dispatchFetch(oauthIssuer + path, {
              headers: { "cf-connecting-ip": "192.0.2.1" },
            })
          );

        const resource = yield* request(oauthPaths.resource),
          issuer = yield* request(oauthPaths.issuer);

        expect(resource.status).toBe(200);
        expect(issuer.status).toBe(200);
        expect(yield* native(() => resource.json())).toMatchObject({
          resource: oauthResource,
          authorization_servers: [oauthIssuer],
        });
        expect(yield* native(() => issuer.json())).toMatchObject({
          issuer: oauthIssuer,
          authorization_endpoint: oauthIssuer + oauthPaths.authorize,
          token_endpoint: oauthIssuer + oauthPaths.token,
          registration_endpoint: oauthIssuer + oauthPaths.register,
          code_challenge_methods_supported: ["S256"],
        });
        const challenge = yield* request(oauthPaths.mcp);
        expect(challenge.status).toBe(401);
        expect(challenge.headers.get("www-authenticate")).toContain(
          oauthIssuer + oauthPaths.resource
        );
      })
  );
  test.effect(
    "binds discovery and one-time confirmations to the current OAuth connection and owner facts",
    () =>
      Effect.gen(function* () {
        const { runtime, owner, session, exchange, client_id, credential, connectionId } =
          yield* nativeGrant;

        const protocol = protocolFor(runtime);

        const rotation = {
          client_id,
          resource: oauthResource,
          grant_type: "refresh_token",
          refresh_token: credential.refresh_token,
          scope: "read",
        };

        const rotated = yield* exchange(rotation);
        expect(rotated.status).toBe(200);

        const winner = yield* Schema.decodeUnknownEffect(tokenPair)(
          yield* native(() => rotated.json())
        );

        expect(winner.access_token).not.toBe(credential.access_token);
        const listed = yield* protocol(winner.access_token, "tools/list");
        expect(listed.status).toBe(200);

        const catalogue = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            result: Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
          })
        )(yield* native(() => listed.json()));

        expect(catalogue.result.tools.map((tool) => tool.name)).toContain(
          "transactions.listTransactions"
        );
        expect(catalogue.result.tools.map((tool) => tool.name)).not.toContain(
          "transactions.createTransaction"
        );

        const records = yield* protocol(winner.access_token, "tools/call", {
          name: "transactions.listTransactions",
          args: { query: {} },
        });

        expect(records.status).toBe(200);
        expect(yield* native(() => records.json())).toMatchObject({ result: { isError: false } });

        yield* Effect.forEach(
          [
            "categories.listCategories",
            "transactions.listTransactions",
            "categories.listCategories",
          ],
          (name) => callTool(protocol, winner.access_token, name),
          { discard: true }
        );

        const connections = yield* session(oauthPaths.connections, alice);
        expect(connections.status).toBe(200);
        expect(yield* native(() => connections.json())).toMatchObject({
          connections: [
            {
              connectionId,
              state: "active",
              recentActivity: [
                { operation: "categories.listCategories" },
                { operation: "transactions.listTransactions" },
                { operation: "categories.listCategories" },
              ],
            },
          ],
        });

        const createdBudget = yield* session("/budgets", alice, {
          categoryId: "10000000-0000-4000-8000-000000000016",
          cap: { amount: "1000", currency: "COP" },
        });

        expect(createdBudget.status).toBe(201);

        const {
          data: { id },
        } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.Struct({ id: Schema.String }) })
        )(yield* native(() => createdBudget.json()));

        const destroy = (state?: string): ReturnType<typeof protocol> =>
          protocol(credential.access_token, "tools/call", {
            name: "budgets.deleteBudget",
            args: { params: { id } },
            continuation: state,
          });

        const ask = yield* destroy();

        const form = Schema.Struct({
          result: Schema.Struct({
            requestState: Schema.String,
            inputRequests: Schema.Struct({
              review: Schema.Struct({ params: Schema.Struct({ message: Schema.String }) }),
            }),
          }),
        });

        const firstReview = yield* Schema.decodeUnknownEffect(form)(
          yield* native(() => ask.json())
        );

        expect(firstReview.result.inputRequests.review.params.message).toContain("1.000 pesos");
        yield* owner.exec(
          "UPDATE budgets SET cap='1200',updated_at_ms=updated_at_ms+1 WHERE id=?",
          id
        );
        const stale = yield* destroy(firstReview.result.requestState);
        expect(yield* native(() => stale.json())).toMatchObject({ result: { isError: true } });
        const refreshed = yield* destroy();

        const secondReview = yield* Schema.decodeUnknownEffect(form)(
          yield* native(() => refreshed.json())
        );

        expect(secondReview.result.inputRequests.review.params.message).toContain("1.200 pesos");

        const consumption = (): ReturnType<typeof owner.exec> =>
          owner.exec(
            "SELECT sum(units) AS n FROM commercial_allowance_consumptions WHERE allowance='canonical_call'"
          );

        expect(yield* consumption()).toEqual([{ n: 6 }]);
        const accepted = yield* destroy(secondReview.result.requestState);
        expect(yield* native(() => accepted.json())).toMatchObject({ result: { isError: false } });
        expect(yield* owner.exec("SELECT count(*) AS n FROM budgets WHERE id=?", id)).toEqual([
          { n: 0 },
        ]);
        expect(yield* consumption()).toEqual([{ n: 6 }]);
        const replayed = yield* destroy(secondReview.result.requestState);
        expect(yield* native(() => replayed.json())).toMatchObject({ result: { isError: true } });

        const independent = yield* protocol(credential.access_token, "tools/call", {
          name: "categories.listCategories",
          args: {},
          continuation: secondReview.result.requestState,
        });

        expect(yield* native(() => independent.json())).toMatchObject({
          result: { isError: false, _meta: { "co.fidy/canonicalAllowance": { remaining: "43" } } },
        });
        const foreignRevoke = yield* session(oauthPaths.revoke, bob, { connectionId });
        expect(foreignRevoke.status).toBe(400);
        yield* native(() => foreignRevoke.text());
        yield* owner.exec(
          "UPDATE oauth_credentials SET issued_at_ms=1,expires_at_ms=2 WHERE kind='refresh' AND consumed_at_ms IS NOT NULL"
        );
        const replay = yield* exchange(rotation);
        expect(replay.status).toBe(400);
        yield* responseText(replay);
        const dead = yield* protocol(winner.access_token, "tools/list");
        expect(dead.status).toBe(401);
        yield* native(() => dead.text());
        const revokeAll = yield* session(oauthPaths.revokeAll, alice, {});
        expect(revokeAll.status).toBe(200);
        yield* native(() => revokeAll.text());
        const revoked = yield* exchange({ ...rotation, refresh_token: winner.refresh_token });
        expect(revoked.status).toBe(400);
        yield* responseText(revoked);
      })
  );
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "revokes the winning generation when concurrent refreshes present the same predecessor",
    () =>
      Effect.gen(function* () {
        const { runtime, owner, exchange, client_id, credential } = yield* nativeGrant;

        const input = {
          client_id,
          resource: oauthResource,
          grant_type: "refresh_token",
          refresh_token: credential.refresh_token,
        };

        const responses = yield* Effect.all([exchange(input), exchange(input)], { concurrency: 2 });
        expect(
          responses.map((response) => response.status).sort((left, right) => left - right)
        ).toEqual([200, 400]);
        const success = responses.find((response) => response.status === 200);

        if (success === undefined) return yield* Effect.die("Missing successful refresh");

        const pair = yield* Schema.decodeUnknownEffect(tokenPair)(
          yield* native(() => success.json())
        );

        const list = yield* protocolFor(runtime)(pair.access_token, "tools/list");
        expect(list.status).toBe(401);
        yield* native(() => list.text());
        expect(
          yield* owner.exec(
            "SELECT count(*) AS n FROM consent_history WHERE record_type='oauth_replay_revocation'"
          )
        ).toEqual([{ n: 1 }]);
      })
  );
  test.effect(
    "keeps a refresh retryable across Directory failure and rejects a foreign destination",
    () =>
      Effect.gen(function* () {
        const { runtime, owner, exchange, session, connectionId, client_id, credential } =
          yield* nativeGrant;

        const input = {
          client_id,
          resource: oauthResource,
          grant_type: "refresh_token",
          refresh_token: credential.refresh_token,
        };

        yield* native(() =>
          owner.directory.exec(
            "CREATE TRIGGER unavailable BEFORE INSERT ON oauth_routes BEGIN SELECT RAISE(ABORT,'unavailable'); END"
          )
        );
        const failure = yield* exchange(input);
        expect(failure.status).toBe(503);
        expect(yield* native(() => failure.json())).toEqual({ error: "temporarily_unavailable" });
        expect(
          yield* owner.exec(
            "SELECT count(*) AS n FROM oauth_credentials WHERE consumed_at_ms IS NOT NULL"
          )
        ).toEqual([{ n: 0 }]);
        yield* native(() => owner.directory.exec("DROP TRIGGER unavailable"));
        const rotated = yield* exchange(input);
        expect(rotated.status).toBe(200);

        const pair = yield* Schema.decodeUnknownEffect(tokenPair)(
          yield* native(() => rotated.json())
        );

        yield* native(() =>
          owner.directory.exec("UPDATE oauth_routes SET user_id=? WHERE kind='access'", bob.user)
        );
        const protocol = protocolFor(runtime);
        expect((yield* protocol(pair.access_token, "tools/list")).status).toBe(401);
        yield* native(() =>
          owner.directory.exec("UPDATE oauth_routes SET user_id=? WHERE kind='access'", alice.user)
        );
        expect((yield* protocol(pair.access_token, "tools/list")).status).toBe(200);
        const refused = yield* session(oauthPaths.revoke, bob, { connectionId });
        expect(refused.status).toBe(400);
        const revoked = yield* session(oauthPaths.revoke, alice, { connectionId });
        expect(revoked.status).toBe(200);
        expect((yield* protocol(pair.access_token, "tools/list")).status).toBe(401);
        expect((yield* exchange({ ...input, refresh_token: pair.refresh_token })).status).toBe(400);
      })
  );
});
