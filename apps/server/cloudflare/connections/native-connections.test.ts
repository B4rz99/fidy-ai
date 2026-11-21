import { admitPurge, caseDriver } from "../erasure-purge.test-fixture";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect, Schedule, Schema } from "effect";
import type { Miniflare } from "miniflare";
import { expect } from "vitest";
import {
  alice,
  bob,
  makeNativeTransactionJourney,
  nativeTransactionJourney,
  seedNativePAT,
} from "../financial-user-store.test-fixture";
import { native, nativeConnectionPlatform } from "../user-store.test-fixture";

const inspectActiveConnection = Effect.fn(function* (
  journey: Effect.Success<typeof nativeTransactionJourney>
) {
  const [connection] = yield* Schema.decodeUnknownEffect(
    Schema.Tuple([Schema.Struct({ id: Schema.String })])
  )(yield* native(() => journey.exec("SELECT id FROM connections")));

  const path = "/connections/" + connection.id;
  const detail = yield* native(() => journey.browser(0, path));
  expect(yield* native(() => detail.json())).toMatchObject({
    data: { id: connection.id, institutionId: "bancolombia", state: "Active" },
  });
  const accounts = yield* native(() => journey.browser(0, path + "/accounts"));

  const result = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      data: Schema.Tuple([
        Schema.Struct({ id: Schema.String.check(Schema.isUUID()), connectionId: Schema.String }),
      ]),
      next: Schema.Array(Schema.Json),
    })
  )(yield* native(() => accounts.json()));

  expect(result.data[0].connectionId).toBe(connection.id);
  expect(result.next).toEqual([]);
  expect((yield* native(() => journey.browser(1, path))).status).toBe(404);
});

const startBankAttempt = Effect.fn(function* (
  journey: Effect.Success<typeof nativeTransactionJourney>
) {
  const send = (path: string, body: unknown): Effect.Effect<Response> =>
    native(() =>
      journey.send(
        new Request("https://api.fidyapp.com" + path, {
          method: "POST",
          headers: {
            origin: "https://app.fidyapp.com",
            cookie: "__Host-fidy_session=" + alice.bearer,
            "Fidy-Session-Binding": alice.session,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        })
      )
    );

  const connect = yield* send("/connections", { institutionId: "bancolombia" });

  const connected = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ data: Schema.Struct({ continuation: Schema.Struct({ url: Schema.String }) }) })
  )(yield* native(() => connect.json()));

  const begin = yield* send("/web/connections/begin", {
    attempt: new URL(connected.data.continuation.url).searchParams.get("attempt"),
  });

  expect(begin.status).toBe(200);

  const provider = (yield* native(() =>
    journey.runtime.getDurableObjectNamespace("CONNECTION_FIXTURE", "core")
  )).getByName("provider");

  const stats = (): Promise<{ state: string; calls: number }> =>
    provider
      .fetch("https://fixture.invalid/status")
      .then((reply) => reply.json())
      .then(Schema.decodeUnknownSync(Schema.Struct({ state: Schema.String, calls: Schema.Int })));

  const state = (yield* native(stats)).state;

  const callback = (
    subject: typeof alice,
    code = "fixture"
  ): Effect.Effect<Awaited<ReturnType<Miniflare["dispatchFetch"]>>> =>
    native(() =>
      journey.runtime.dispatchFetch(
        "https://api.fidyapp.com/connections/bancolombia/sandbox/callback?" +
          new URLSearchParams({ code, state }),
        {
          headers: { cookie: "__Host-fidy_session=" + subject.bearer },
          redirect: "manual",
        }
      )
    );

  return { provider, stats, callback };
});

const runningSynchronization = Effect.fn(function* () {
  const journey = yield* makeNativeTransactionJourney(undefined, nativeConnectionPlatform);
  const { provider, stats, callback } = yield* startBankAttempt(journey);
  expect((yield* callback(bob)).status).toBe(303);
  expect(
    yield* native(() => journey.exec("SELECT count(*) AS count FROM connection_grants"))
  ).toEqual([{ count: 0 }]);
  expect((yield* callback(alice)).status).toBe(303);
  expect(yield* native(() => journey.exec("SELECT state FROM connections"))).toEqual([
    { state: "Active" },
  ]);
  yield* native(() =>
    expect.poll(() => stats().then((value) => value.calls), { timeout: 15000 }).toBe(1)
  );
  yield* inspectActiveConnection(journey);
  expect((yield* native(() => journey.browser(0))).status).toBe(200);

  const jobRow = yield* native(() =>
    journey.exec("SELECT id FROM connection_synchronizations WHERE state='running'")
  );

  const [job] = yield* Schema.decodeUnknownEffect(
    Schema.Tuple([Schema.Struct({ id: Schema.String })])
  )(jobRow);

  const packet = { kind: "connection-synchronization", userId: alice.user, jobId: job.id };

  const users = yield* native(() =>
    journey.runtime.getDurableObjectNamespace("USER_STORE", "core")
  );

  const resume = (user: string): Effect.Effect<Pick<Response, "status">> =>
    native(() =>
      users.getByName(user).fetch("https://user.invalid/work/connection-synchronization", {
        method: "POST",
        body: JSON.stringify(packet),
      })
    );

  const facts = (): ReturnType<typeof journey.exec> =>
    journey.exec(
      "SELECT (SELECT count(*) FROM transactions) AS movements,(SELECT count(*) FROM audit_entries WHERE record_type='connection_synchronization') AS audits,(SELECT count(*) FROM connection_synchronizations WHERE state='complete') AS completed"
    );

  return { journey, stats, provider, resume, facts, packet };
});

const rejectedGrantJourney = Effect.gen(function* () {
  const journey = yield* makeNativeTransactionJourney(undefined, nativeConnectionPlatform);
  const first = yield* startBankAttempt(journey);
  expect((yield* first.callback(alice, "reject-held")).status).toBe(303);

  const grants =
    "SELECT attempt_id,state,envelope IS NOT NULL AS held,cleaned_at_ms IS NOT NULL AS cleaned FROM connection_grants ORDER BY rowid";

  const [failed] = yield* Schema.decodeUnknownEffect(
    Schema.Tuple([
      Schema.Struct({
        attempt_id: Schema.String,
        state: Schema.Literal("cleanup_required"),
        held: Schema.Literal(1),
        cleaned: Schema.Literal(0),
      }),
    ])
  )(yield* native(() => journey.exec(grants)));

  expect(yield* native(() => journey.exec("SELECT state FROM connections"))).toEqual([
    { state: "Action required" },
  ]);
  const newer = yield* startBankAttempt(journey);
  expect((yield* newer.callback(alice)).status).toBe(303);
  expect((yield* first.callback(alice, "reject-held")).status).toBe(303);
  expect(yield* native(() => journey.exec(grants))).toMatchObject([
    { attempt_id: failed.attempt_id, state: "cleanup_required", held: 1 },
    { state: "active", held: 1, cleaned: 0 },
  ]);
  yield* native(() => newer.provider.fetch("https://fixture.invalid/release"));
  yield* native(() =>
    expect
      .poll(
        () =>
          journey.exec(
            "SELECT cleanup_claim IS NULL AS released,cleanup_access_seen AS observed,cleanup_after_ms>0 AS deferred FROM connection_grants WHERE attempt_id=?",
            failed.attempt_id
          ),
        { timeout: 5000 }
      )
      .toEqual([{ released: 1, observed: 1, deferred: 1 }])
  );
  yield* native(() => newer.provider.fetch("https://fixture.invalid/allow-cleanup"));
  yield* native(() =>
    journey.exec(
      "UPDATE connection_grants SET cleanup_after_ms=0 WHERE attempt_id=?",
      failed.attempt_id
    )
  );

  const users = yield* native(() =>
    journey.runtime.getDurableObjectNamespace("USER_STORE", "core")
  );

  const recovery = yield* native(() =>
    users.getByName(alice.user).fetch("https://fixture.invalid/connection-recovery")
  );

  expect(recovery.status).toBe(204);
  expect(yield* native(() => journey.exec(grants))).toMatchObject([
    { attempt_id: failed.attempt_id, state: "cleanup_required", held: 0, cleaned: 1 },
    { state: "active", held: 1, cleaned: 0 },
  ]);
  const reply = yield* native(() => newer.provider.fetch("https://fixture.invalid/status"));
  expect(yield* native(() => reply.json())).toMatchObject({
    lastRevoked: "failed",
    revocations: 1,
  });
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "quarantines a rejected bank exchange and revokes only its held generation after a later activation",
    () => rejectedGrantJourney
  );
  test.effect("discovers the gated institution through its User and audits the read locally", () =>
    Effect.gen(function* () {
      const journey = yield* nativeTransactionJourney;
      const response = yield* native(() => journey.browser(0, "/institutions"));
      expect(response.status).toBe(200);
      expect(yield* native(() => response.json())).toEqual({
        data: [
          {
            id: "bancolombia",
            displayName: "Bancolombia",
            availability: "unavailable",
            connection: null,
          },
        ],
        next: [],
      });
      expect(
        yield* native(() =>
          journey.exec(
            "SELECT outcome FROM audit_entries WHERE operation='connections.listInstitutions'"
          )
        )
      ).toEqual([{ outcome: "success" }]);
    })
  );

  test.effect(
    "reuses one attempt, refuses a duplicate target, and rolls back Connection, attempt and Audit on a later child failure",
    () =>
      Effect.gen(function* () {
        const journey = yield* makeNativeTransactionJourney(undefined, nativeConnectionPlatform);
        const payload = { institutionId: "bancolombia" };

        const first = {
          callId: alice.user,
          operation: "connections.connectInstitution",
          input: { payload },
        };

        const sibling = { callId: bob.user, operation: "dashboard.initializeDashboard", input: {} };

        const send = (path: string, body: unknown, subject = alice): Effect.Effect<Response> =>
          native(() =>
            journey.send(
              new Request("https://api.fidyapp.com" + path, {
                method: "POST",
                headers: {
                  origin: "https://app.fidyapp.com",
                  cookie: "__Host-fidy_session=" + subject.bearer,
                  "Fidy-Session-Binding": subject.session,
                  "content-type": "application/json",
                },
                body: JSON.stringify(body),
              })
            )
          );

        const batch = (second: typeof sibling | typeof first): Effect.Effect<Response> =>
          send("/operations/atomic-batch", { calls: [first, second] });

        expect((yield* send("/connections", payload, bob)).status).toBe(400);
        expect((yield* batch({ ...first, callId: bob.user })).status).toBe(400);
        yield* native(() =>
          journey.exec(
            "CREATE TRIGGER deny_sibling BEFORE INSERT ON audit_entries WHEN NEW.operation='dashboard.initializeDashboard' BEGIN SELECT RAISE(ABORT,'interrupted'); END"
          )
        );
        expect((yield* batch(sibling)).status).toBe(503);
        expect(
          yield* native(() =>
            journey.exec(
              "SELECT (SELECT count(*) FROM connections) AS connections,(SELECT count(*) FROM connection_attempts) AS attempts,(SELECT count(*) FROM audit_entries WHERE operation='connections.connectInstitution' AND outcome='success') AS accepted"
            )
          )
        ).toEqual([{ connections: 0, attempts: 0, accepted: 0 }]);
        yield* native(() => journey.exec("DROP TRIGGER deny_sibling"));
        const response = yield* batch(sibling);
        expect(response.status).toBe(200);
        const result = yield* native(() => response.json());
        const repeated = yield* send("/connections", payload);
        expect(repeated.status).toBe(200);

        const started = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            data: Schema.Struct({
              type: Schema.String,
              continuation: Schema.Struct({ url: Schema.String, expiresAt: Schema.String }),
              connection: Schema.Json,
            }),
            next: Schema.Array(Schema.Json),
          })
        )(yield* native(() => repeated.json()));

        expect(result).toMatchObject({
          data: { results: [{ output: started }, { callId: bob.user }] },
        });
        expect(
          yield* native(() => journey.exec("SELECT count(*) AS count FROM connection_attempts"))
        ).toEqual([{ count: 1 }]);
        const url = new URL(started.data.continuation.url);

        const review = yield* native(() =>
          journey.browser(0, "/web/connections/review" + url.search)
        );

        expect(review.status).toBe(200);
        expect(yield* native(() => review.json())).toMatchObject({
          phase: "ready",
          connection: started.data.connection,
        });

        const begin = yield* send("/web/connections/begin", {
          attempt: url.searchParams.get("attempt"),
        });

        expect(begin.status).toBe(200);
        expect(
          yield* native(() =>
            journey.exec("SELECT consent_id,phase FROM connection_authorizations")
          )
        ).toEqual([{ consent_id: "test-consent", phase: "prepared" }]);

        const prepared = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            phase: Schema.Literal("prepared"),
            authorization: Schema.Struct({ url: Schema.String }),
          })
        )(yield* native(() => begin.json()));

        expect(new URL(prepared.authorization.url).searchParams.has("request_uri")).toBe(true);
      })
  );

  test.effect(
    "continues an exact admitted page after withdrawal, fences a foreign User, and recovers a lost reply once",
    () =>
      Effect.gen(function* () {
        const { journey, stats, provider, resume, facts, packet } = yield* runningSynchronization();
        expect((yield* resume(bob.user)).status).toBe(404);
        const now = yield* Clock.currentTimeMillis;
        yield* native(() =>
          journey.exec(
            "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms) VALUES('withdrawn',?,'processing_withdrawal',?)",
            alice.user,
            now
          )
        );
        yield* native(() => provider.fetch("https://fixture.invalid/release"));
        yield* native(() =>
          expect
            .poll(facts, { timeout: 15000 })
            .toEqual([{ movements: 1, audits: 1, completed: 1 }])
        );
        expect((yield* resume(alice.user)).status).toBe(204);

        const transport = yield* native(() =>
          journey.runtime.getBindings<{
            CONNECTION_SYNCHRONIZATION_QUEUE: Queue;
            CONNECTION_SYNCHRONIZATION_WORKFLOW: Workflow;
          }>("core")
        );

        yield* native(() =>
          transport.CONNECTION_SYNCHRONIZATION_QUEUE.sendBatch([{ body: packet }, { body: packet }])
        );

        const instance = yield* native(() =>
          transport.CONNECTION_SYNCHRONIZATION_WORKFLOW.get(packet.jobId)
        );

        yield* native(() => instance.status()).pipe(
          Effect.repeat({
            until: (state) => state.status === "complete",
            schedule: Schedule.spaced("25 millis"),
          }),
          Effect.timeout("10 seconds")
        );
        expect((yield* native(stats)).calls).toBe(1);
        yield* native(() => journey.exec("UPDATE connection_refresh SET next_refresh_ms=?", now));
        yield* native(() => journey.checkWork(alice.user));
        expect(
          yield* native(() => journey.exec("SELECT count(*) AS n FROM connection_synchronizations"))
        ).toEqual([{ n: 1 }]);
        yield* native(() =>
          journey.exec(
            "INSERT INTO consent_history(id,user_id,withdrawal_id,record_type,occurred_at_ms) VALUES('renewed',?,'withdrawn','processing_renewal',?)",
            alice.user,
            now
          )
        );
        yield* native(() => journey.exec("UPDATE connection_refresh SET next_refresh_ms=?", now));
        yield* native(() => journey.checkWork(alice.user));
        yield* native(() =>
          expect
            .poll(facts, { timeout: 15000 })
            .toEqual([{ movements: 1, audits: 2, completed: 2 }])
        );
        expect(
          yield* native(() =>
            journey.exec(
              "SELECT count(*) AS attestations FROM source_attestations WHERE kind='connection-movement'"
            )
          )
        ).toEqual([{ attestations: 1 }]);
        const history = yield* native(() => journey.browser(0));
        expect(yield* native(() => history.text())).toContain("Pago institución");
        expect(
          yield* native(() =>
            journey.owner(bob.user).exec("SELECT count(*) AS count FROM transactions")
          )
        ).toEqual([{ count: 0 }]);
      })
  );
  test.effect("refuses a stale Connection result after the provider has begun reading", () =>
    Effect.gen(function* () {
      const { journey, provider, facts } = yield* runningSynchronization();
      yield* native(() => journey.exec("UPDATE connections SET state='Ended'"));
      yield* native(() => provider.fetch("https://fixture.invalid/release"));

      const state = (): ReturnType<typeof journey.exec> =>
        journey.exec("SELECT state FROM connection_synchronizations");

      yield* native(() =>
        expect
          .poll(state, {
            timeout: 15000,
          })
          .toEqual([{ state: "cancelled" }])
      );
      expect(yield* native(facts)).toEqual([{ movements: 0, audits: 0, completed: 0 }]);
    })
  );
  test.effect(
    "recovers a failed financial-page Audit on the same job and never commits a partial page",
    () =>
      Effect.gen(function* () {
        const { journey, provider, resume, facts } = yield* runningSynchronization();
        yield* native(() =>
          journey.exec(
            "CREATE TRIGGER interrupt_page BEFORE INSERT ON audit_entries WHEN NEW.record_type='connection_synchronization' BEGIN SELECT RAISE(ABORT,'interrupted'); END"
          )
        );
        yield* native(() => provider.fetch("https://fixture.invalid/release"));
        expect((yield* resume(alice.user)).status).toBe(503);
        expect(yield* native(facts)).toEqual([{ movements: 0, audits: 0, completed: 0 }]);
        expect(
          yield* native(() =>
            journey.exec(
              "SELECT cursor,last_success_ms,(SELECT count(*) FROM source_attestations) AS attestations,(SELECT count(*) FROM connection_movements) AS references_count FROM connection_refresh"
            )
          )
        ).toEqual([{ cursor: null, last_success_ms: null, attestations: 0, references_count: 0 }]);

        const pending = (): ReturnType<typeof journey.exec> =>
          journey.exec("SELECT state FROM connection_synchronizations");

        yield* native(() => expect.poll(pending).toEqual([{ state: "pending" }]));
        yield* native(() => journey.exec("DROP TRIGGER interrupt_page"));
        expect((yield* resume(alice.user)).status).toBe(204);
        expect((yield* resume(alice.user)).status).toBe(204);
        expect(yield* native(facts)).toEqual([{ movements: 1, audits: 1, completed: 1 }]);
      })
  );
  test.effect(
    "applies read and write PAT authority to the same Connection start and replays only under a live grant",
    () =>
      Effect.gen(function* () {
        const journey = yield* makeNativeTransactionJourney(undefined, nativeConnectionPlatform);
        const current = yield* Clock.currentTimeMillis;

        const read = "fin_rrrrrrrr_" + "a".repeat(43),
          write = "fin_wwwwwwww_" + "b".repeat(43);

        yield* seedNativePAT({
          db: journey,
          userId: alice.user,
          token: read,
          scopes: ["read"],
          current,
        });
        yield* seedNativePAT({
          db: journey,
          userId: alice.user,
          token: write,
          scopes: ["write"],
          current,
        });

        const headersFor = (token: string): HeadersInit => ({
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "Fidy-Retry-Key": "original",
        });

        const call = (token: string, method: "GET" | "POST"): Effect.Effect<Response> =>
          native(() =>
            journey.send(
              new Request(
                "https://api.fidyapp.com/connections",
                method === "POST"
                  ? {
                      method,
                      headers: headersFor(token),
                      body: JSON.stringify({ institutionId: "bancolombia" }),
                    }
                  : { method, headers: headersFor(token) }
              )
            )
          );

        expect((yield* call(read, "POST")).status).toBe(403);
        expect((yield* call(read, "GET")).status).toBe(200);
        expect((yield* call(write, "GET")).status).toBe(403);
        const first = yield* call(write, "POST");
        const retry = yield* call(write, "POST");
        expect([first.status, retry.status]).toEqual([200, 200]);
        expect(yield* native(() => first.text())).toBe(yield* native(() => retry.text()));
        expect(
          yield* native(() => journey.exec("SELECT count(*) AS count FROM connection_attempts"))
        ).toEqual([{ count: 1 }]);
        yield* native(() =>
          journey.exec("UPDATE pats SET revoked_at_ms=? WHERE short_id='wwwwwwww'", current)
        );
        expect((yield* call(write, "POST")).status).toBe(401);
      })
  );
  test.effect(
    "erasure suppresses an active Connection and clears its encrypted tokens after checked revocation",
    () =>
      Effect.gen(function* () {
        const { journey, provider } = yield* runningSynchronization();
        expect((yield* admitPurge(journey.runtime)).status).toBe(202);
        const driver = yield* caseDriver(journey.runtime);
        yield* driver.step();
        yield* driver.step();
        yield* native(() => provider.fetch("https://fixture.invalid/release"));
        yield* native(() => journey.checkWork(alice.user));

        const cleanup = (): ReturnType<typeof journey.exec> =>
          journey.exec(
            "SELECT cleaned_at_ms IS NOT NULL AS cleaned,envelope IS NULL AS cleared,cleanup_access_seen AS observed FROM connection_grants"
          );

        yield* native(() =>
          expect
            .poll(cleanup, { timeout: 15000 })
            .toEqual([{ cleaned: 1, cleared: 1, observed: 1 }])
        );
        yield* native(() => journey.checkWork(alice.user));
        const reply = yield* native(() => provider.fetch("https://fixture.invalid/status"));
        expect(yield* native(() => reply.json())).toMatchObject({ revocations: 1 });
        expect(yield* driver.step()).toBe("Draining");
        expect(
          yield* native(() => driver.storage.exec("SELECT connection_blocked FROM erasure_cases"))
        ).toEqual([{ connection_blocked: 1 }]);
        expect(
          yield* native(() =>
            driver.storage.exec("SELECT count(*) AS n FROM erasure_case_custodians")
          )
        ).toEqual([{ n: 0 }]);
      })
  );
});
