import { UserId } from "../../src/core/identity/contract";
import { fixtureWorker as scheduledCoreWorker } from "../core-worker.test-fixture";
import { activationFixture } from "../bancolombia-activation.test-fixture";
import { requiresErasureSuppression } from "./operations";
import { type Cause, DateTime, Deferred, Effect, Fiber, Option, Redacted, Schema } from "effect";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { approvedWorkersAiModel } from "../../src/shell/hosted-inference/contract";
import { UserTransactionCoordinator } from "../transactions/runtime";
import { makeCoreWorker } from "../core-worker";
import { cloudflareWorkerTelemetry } from "../runtime/telemetry/operations";
import publicWorker from "../public-worker";
import { ConnectInstitutionResult, InstitutionId } from "../../src/core/connections/contract";
import {
  handleConnectionBrowserRequest,
  makeConnectionsErasureStores,
  sweepConnectionAttempts,
  sweepConnectionGrants,
} from "./runtime";
import { workerInternalTraceHeader } from "../runtime/telemetry/contract";
import { Base64Url } from "effect/encoding";
import {
  ConnectionAuthorizationUnavailable,
  type ConnectionBankActivation,
  type ConnectionBankPreparation,
  ConnectionConsentIntent,
  ConnectionGrantKey,
} from "./contract";

const institutionRegistration = { enabled: false };
let bankPreparation: Option.Option<ConnectionBankPreparation> = Option.none();
let bankActivation: Option.Option<ConnectionBankActivation> = Option.none();
let sandboxProfile = Option.none<string>();

const fixtureConsentIntent = (): ConnectionBankPreparation["intent"] => ({
  permissions: [
    "ReadAccountsBasic",
    "ReadTransactionsCredits",
    "ReadBalances",
    "ReadTransactionsDebits",
    "ReadTransactionsDetail",
  ],
  historyPolicy: "bank-default",
  expiryPolicy: "bank-default",
});

const users = [
  "10000000-0000-4000-8000-000000000051",
  "10000000-0000-4000-8000-000000000052",
] as const;
const sessions = [
  "10000000-0000-4000-8000-000000000061",
  "10000000-0000-4000-8000-000000000062",
] as const;
const databases = isolatedTestDatabases();
const bearer = (index: number): string => String(index + 1).repeat(43);
const digest = (text: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(text))
    .then((value) => new Uint8Array(value));
const seedUser = (
  db: D1Database,
  input: Readonly<{
    user: string;
    index: number;
    current: number;
  }>
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const { user, index, current } = input;
    const verifierDigest = yield* Effect.tryPromise(() => digest(`verifier${index}`));
    const tokenDigest = yield* Effect.tryPromise(() => digest(bearer(index)));
    yield* Effect.tryPromise(() =>
      db.batch([
        db
          .prepare(
            "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)"
          )
          .bind(user, current),
        db
          .prepare(
            "INSERT INTO browser_login_pairings (id, public_code, verifier_digest, user_id, state, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, 'consumed', ?, ?)"
          )
          .bind(
            `10000000-0000-4000-8000-00000000007${index}`,
            `ABCD-123${index}`,
            verifierDigest,
            user,
            current,
            current + 600000
          ),
        db
          .prepare(
            "INSERT INTO web_sessions (id, pairing_id, user_id, token_digest, created_at_ms, fresh_until_ms, idle_expires_at_ms, hard_expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .bind(
            sessions[index],
            `10000000-0000-4000-8000-00000000007${index}`,
            user,
            tokenDigest,
            current,
            current + 600000,
            current + 3600000,
            current + 7776000000
          ),
      ])
    );
  });
const setup = (): Effect.Effect<D1Database, Cause.UnknownError> =>
  Effect.gen(function* () {
    const db = yield* Effect.tryPromise(() => databases.acquire());

    yield* Effect.tryPromise(() => installTestSchema({ db }));
    const current = DateTime.nowUnsafe().epochMilliseconds;
    yield* Effect.forEach(users, (user, index) => seedUser(db, { user, index, current }), {
      discard: true,
    });
    return db;
  });
afterAll(() => databases.dispose());
beforeEach(() => {
  institutionRegistration.enabled = false;
  bankPreparation = Option.none();
  bankActivation = Option.none();
  sandboxProfile = Option.none();
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const coordinatorByDatabase = new WeakMap<D1Database, Map<string, UserTransactionCoordinator>>();
const send = (
  db: D1Database,
  request: Request,
  beforeCoordinate?: (database: D1Database) => Promise<unknown>
): Promise<Response> => {
  const institutions = institutionRegistration.enabled ? [InstitutionId.make("bancolombia")] : [];
  const coreWorker = makeCoreWorker({
    telemetry: cloudflareWorkerTelemetry,
    institutions,
  });
  vi.setSystemTime(DateTime.nowUnsafe().epochMilliseconds + 1000);
  request.headers.set("cf-connecting-ip", "192.0.2.35");
  const coordinators =
    coordinatorByDatabase.get(db) ?? new Map<string, UserTransactionCoordinator>();
  coordinatorByDatabase.set(db, coordinators);
  return publicWorker.fetch(request, {
    BROWSER_ORIGIN: "https://app.fidyapp.com",
    LOCAL_CANONICAL_READ_BEARER: "",
    PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
    RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
    CORE: {
      fetch: (internal) =>
        coreWorker.fetch(new Request(internal), {
          DB: db,
          BANCOLOMBIA_SANDBOX_CONSENT_PROFILE: Option.getOrUndefined(sandboxProfile),
          AI: { run: (): Promise<never> => Promise.reject(new Error("unused")) },
          CONTRACT_DIGEST: "a".repeat(64),
          RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
          HOSTED_AI_MODEL: approvedWorkersAiModel,
          BROWSER_ORIGIN: "https://app.fidyapp.com",
          WOMPI_ENVIRONMENT: "",
          WOMPI_PUBLIC_KEY: "",
          WOMPI_PRIVATE_KEY: "",
          WOMPI_INTEGRITY_SECRET: "",
          USER_TRANSACTION_COORDINATOR: {
            getByName: (name) => ({
              fetch: (command) => {
                let coordinator = coordinators.get(`${name}:${institutionRegistration.enabled}`);
                if (coordinator === undefined) {
                  coordinator = new UserTransactionCoordinator(
                    {
                      id: { name },
                      storage: {
                        getAlarm: (): ReturnType<DurableObjectStorage["getAlarm"]> =>
                          Promise.resolve(null),
                        deleteAlarm: (): Promise<void> => Promise.resolve(),
                        setAlarm: (): Promise<void> => Promise.resolve(),
                      },
                    },
                    {
                      DB: db,
                      BANCOLOMBIA_SANDBOX_CONSENT_PROFILE: Option.getOrUndefined(sandboxProfile),
                      BANCOLOMBIA_SANDBOX_GRANT_KEY: "A".repeat(43),
                      AI: { run: (): Promise<never> => Promise.reject(new Error("unused")) },
                      HOSTED_AI_MODEL: approvedWorkersAiModel,
                    },
                    { institutions, bank: bankPreparation, activation: bankActivation }
                  );
                  coordinators.set(`${name}:${institutionRegistration.enabled}`, coordinator);
                }
                const admittedCoordinator = coordinator;
                return beforeCoordinate === undefined
                  ? admittedCoordinator.fetch(new Request(command))
                  : beforeCoordinate(db).then(() =>
                      admittedCoordinator.fetch(new Request(command))
                    );
              },
            }),
          },
          KAPSO_API_KEY: "",
          WHATSAPP_SANDBOX_PHONE_NUMBER_ID: "",
          KAPSO_WEBHOOK_SECRET: "",
          WHATSAPP_BUSINESS_PORTFOLIO_ID: "portfolio",
          CLOUDFLARE_ACCESS_ISSUER: "",
          CLOUDFLARE_ACCESS_AUDIENCE: "",
        }),
    },
  });
};
const request = (
  index: number,
  path: string,
  ...args: [method?: string, body?: object]
): Request => {
  const [method = "GET", body] = args;
  const init: RequestInit = {
    method,
    headers: {
      origin: "https://app.fidyapp.com",
      "Fidy-Session-Binding": sessions[index] ?? "invalid",
      cookie: `__Host-fidy_session=${bearer(index)}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
  };
  const value = new Request(
    `https://api.fidyapp.com${path}`,
    body === undefined
      ? init
      : {
          ...init,
          body: JSON.stringify(body),
        }
  );
  if (path.startsWith("/connections/bancolombia/sandbox/callback")) {
    value.headers.delete("Fidy-Session-Binding");
  }
  return value;
};
it("discovers Bancolombia as unavailable without creating a Connection or exposing institution plumbing", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const response = yield* Effect.tryPromise(() => send(db, request(0, "/institutions")));
      expect(response.status).toBe(200);
      expect(yield* Effect.tryPromise(() => response.json())).toEqual({
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
      const list = yield* Effect.tryPromise(() => send(db, request(0, "/connections")));
      expect(list.status).toBe(200);
      expect(yield* Effect.tryPromise(() => list.json())).toEqual({ data: [], next: [] });
    })
  ));
it("admits only the configured sandbox User within its fixed window and rechecks before browser preparation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const now = DateTime.nowUnsafe().epochMilliseconds;
      sandboxProfile = Option.some(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          contract: "bancolombia-sandbox-consent-2026-10-27",
          userId: UserId.make(users[0]),
          admission: {
            startsAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
            expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 60000)),
          },
          financialId: "",
          accountOwner: { SchemeName: "CC", Identification: "synthetic" },
          intent: yield* Schema.encodeEffect(ConnectionConsentIntent)(fixtureConsentIntent()),
        })
      );
      for (const index of [0, 1]) {
        const response = yield* Effect.tryPromise(() => send(db, request(index, "/institutions")));
        expect(yield* Effect.tryPromise(() => response.json())).toMatchObject({
          data: [{ availability: index === 0 ? "available" : "unavailable" }],
        });
      }
      const started = yield* Effect.tryPromise(() =>
        send(db, request(0, "/connections", "POST", { institutionId: "bancolombia" }))
      );
      expect(started.status).toBe(200);
      const reference = yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT public_reference FROM connection_attempts")
          .first<string>("public_reference")
      );
      vi.setSystemTime(now + 60000);
      const expired = yield* Effect.tryPromise(() =>
        send(db, request(0, "/web/connections/begin", "POST", { attempt: reference }))
      );
      expect(expired.status).toBe(404);
      const foreign = yield* Effect.tryPromise(() =>
        send(db, request(1, "/connections", "POST", { institutionId: "bancolombia" }))
      );
      expect(foreign.status).toBe(400);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS total FROM connection_authorizations")
            .first<number>("total")
        )
      ).toBe(0);
    })
  ));

it("starts a stable Connecting association and reuses its original browser attempt", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      institutionRegistration.enabled = true;
      const first = yield* Effect.tryPromise(() =>
        send(db, request(0, "/connections", "POST", { institutionId: "bancolombia" }))
      );
      expect(first.status).toBe(200);
      const started = yield* Effect.tryPromise(() => first.json());
      expect(started).toMatchObject({
        data: {
          type: "continue_in_browser",
          connection: { institutionId: "bancolombia", state: "Connecting" },
        },
      });
      const repeated = yield* Effect.tryPromise(() =>
        send(db, request(0, "/connections", "POST", { institutionId: "bancolombia" }))
      );
      expect(repeated.status).toBe(200);
      expect(yield* Effect.tryPromise(() => repeated.json())).toEqual(started);
      const listed = yield* Effect.tryPromise(() => send(db, request(0, "/connections")));
      expect(yield* Effect.tryPromise(() => listed.json())).toMatchObject({
        data: [{ institutionId: "bancolombia", state: "Connecting" }],
      });
    })
  ));
const decodeStartResponse = (
  response: Response
): Effect.Effect<ConnectInstitutionResult, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const data = yield* Effect.tryPromise(() => response.json());
    return (yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        data: Schema.toCodecJson(ConnectInstitutionResult),
        next: Schema.Array(Schema.Unknown),
      })
    )(data)).data;
  });

const start = (db: D1Database, index = 0): Promise<ConnectInstitutionResult> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise(() =>
        send(db, request(index, "/connections", "POST", { institutionId: "bancolombia" }))
      );
      expect(response.status).toBe(200);
      return (yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          data: Schema.toCodecJson(ConnectInstitutionResult),
          next: Schema.Array(Schema.Unknown),
        })
      )(yield* Effect.tryPromise(() => response.json()))).data;
    })
  );
it("returns a bank callback to a fixed first-party result without reflecting authorization credentials", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const response = yield* Effect.tryPromise(() =>
        send(
          db,
          request(
            0,
            "/connections/bancolombia/sandbox/callback?code=synthetic-code&state=" + "s".repeat(43)
          )
        )
      );
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("https://app.fidyapp.com/connections/result");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(yield* Effect.tryPromise(() => response.text())).not.toContain("synthetic-code");
    })
  ));
const prepareActivation = (
  db: D1Database,
  userIndex = 0
): Effect.Effect<
  Readonly<{
    bank: Effect.Success<typeof activationFixture>;
    started: Extract<ConnectInstitutionResult, { type: "continue_in_browser" }>;
    state: string;
    callback: (index?: number, query?: string) => Promise<Response>;
  }>,
  Cause.UnknownError | Schema.SchemaError
> =>
  Effect.gen(function* () {
    institutionRegistration.enabled = true;
    coordinatorByDatabase.delete(db);
    const bank = yield* activationFixture;
    bankActivation = Option.some(bank.activation);
    let state = "";
    bankPreparation = Option.some({
      intent: fixtureConsentIntent(),
      prepare: (input) => {
        state = input.state;
        return input.recordConsent("synthetic-consent").pipe(
          Effect.as({
            url: "https://auth1-api-open-finance-sandbox.ambientesbc.com/auth?client_id=10000000-0000-4000-8000-000000000001&response_type=code&scope=accounts&request_uri=urn:ietf:params:oauth:request_uri:synthetic",
            expiresAtMilliseconds: DateTime.nowUnsafe().epochMilliseconds + 90000,
          })
        );
      },
    });
    const started = yield* Effect.tryPromise(() => start(db, userIndex));
    if (started.type !== "continue_in_browser") throw new Error("Expected continuation");
    const attempt = new URL(started.continuation.url).searchParams.get("attempt");
    expect(
      (yield* Effect.tryPromise(() =>
        send(db, request(userIndex, "/web/connections/begin", "POST", { attempt }))
      )).status
    ).toBe(200);
    const callback = (
      index = userIndex,
      query = `code=synthetic-code&state=${state}`
    ): Promise<Response> =>
      send(db, request(index, `/connections/bancolombia/sandbox/callback?${query}`));
    return { bank, started, state, callback };
  });
it.each(["ready", "paginated"] as const)(
  "activates one owned Connection after a complete %s bank round trip, keeps tokens encrypted and refuses replay",
  (scenario) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const { bank, started, callback } = yield* prepareActivation(db);
        bank.scenario(scenario);
        expect(
          (yield* Effect.tryPromise(() => Promise.all([callback(), callback()]))).map(
            (response) => response.status
          )
        ).toEqual([303, 303]);
        const listed = yield* Effect.tryPromise(() => send(db, request(0, "/connections")));
        expect(yield* Effect.tryPromise(() => listed.json())).toMatchObject({
          data: [{ id: started.connection.id, state: "Active" }],
        });
        expect(bank.exchanges()).toBe(1);
        expect((yield* Effect.tryPromise(() => callback())).status).toBe(303);
        expect(bank.exchanges()).toBe(1);
        const retained = yield* Effect.tryPromise(() =>
          db.prepare("SELECT * FROM connection_grants").all()
        );
        const storage = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          retained.results
        );
        expect(storage).not.toContain("synthetic-access");
        expect(storage).not.toContain("synthetic-refresh");
        expect(retained.results).toHaveLength(1);
        const accounts = yield* Effect.tryPromise(() =>
          send(db, request(0, `/connections/${started.connection.id}/accounts`))
        );
        expect(accounts.status).toBe(200);
        expect(yield* Effect.tryPromise(() => accounts.json())).toMatchObject({
          data: [{ connectionId: started.connection.id }, { connectionId: started.connection.id }],
          next: [],
        });
        expect(
          (yield* Effect.tryPromise(() =>
            send(db, request(1, `/connections/${started.connection.id}/accounts`))
          )).status
        ).toBe(404);
      })
    )
);
it.each([
  "issuer",
  "subject",
  "expired",
  "future",
  "not-before",
  "intent",
  "authorized-party",
  "access-hash",
  "code-hash",
  "state-hash",
  "audience",
  "signature",
  "consent",
  "permissions",
  "malformed",
  "duplicate",
  "partial",
  "foreign-page",
  "looped-page",
  "skipped-page",
  "over-limit",
  "invalid-position",
  "truncated",
  "contradictory",
  "uncertain",
] as const)(
  "refuses %s bank authority without Account settlement or a repeated code exchange",
  (scenario) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const { bank, started, callback } = yield* prepareActivation(db);
        bank.scenario(scenario);
        expect((yield* Effect.tryPromise(() => callback())).status).toBe(303);
        const listed = yield* Effect.tryPromise(() => send(db, request(0, "/connections")));
        expect(yield* Effect.tryPromise(() => listed.json())).toMatchObject({
          data: [{ state: "Action required" }],
        });
        const accounts = yield* Effect.tryPromise(() =>
          send(db, request(0, `/connections/${started.connection.id}/accounts`))
        );
        expect(yield* Effect.tryPromise(() => accounts.json())).toEqual({ data: [], next: [] });
        yield* Effect.tryPromise(() => callback());
        expect(bank.exchanges()).toBe(1);
        expect(
          (yield* Effect.tryPromise(() => db.prepare("SELECT state FROM connection_grants").all()))
            .results
        ).toEqual([{ state: "cleanup_required" }]);
        expect(
          (yield* Effect.tryPromise(() => db.prepare("SELECT id FROM connection_accounts").all()))
            .results
        ).toEqual([]);
      })
    )
);
it("refuses foreign, wrong-state and denied callbacks without exchanging any code", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const { bank, state, callback } = yield* prepareActivation(db);
      yield* Effect.tryPromise(() => callback(1));
      yield* Effect.tryPromise(() => callback(0, `code=synthetic-code&state=${"s".repeat(43)}`));
      yield* Effect.tryPromise(() =>
        callback(0, `code=synthetic-code&state=${state}&iss=https://evil.example`)
      );
      yield* Effect.tryPromise(() => callback(0, `error=access_denied&state=${state}`));
      yield* Effect.tryPromise(() => callback());
      expect(bank.exchanges()).toBe(0);
      const listed = yield* Effect.tryPromise(() => send(db, request(0, "/connections")));
      expect(yield* Effect.tryPromise(() => listed.json())).toMatchObject({
        data: [{ state: "Action required" }],
      });
    })
  ));
it("rolls back Accounts and Active authority when the completion Audit cannot commit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const { bank, callback } = yield* prepareActivation(db);
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "CREATE TRIGGER fail_activation_audit BEFORE INSERT ON audit_entries WHEN NEW.operation='connections.completeAuthorization' BEGIN SELECT RAISE(ABORT,'synthetic_audit_failure'); END"
          )
          .run()
      );
      yield* Effect.tryPromise(() => callback());
      expect(bank.exchanges()).toBe(1);
      expect(
        (yield* Effect.tryPromise(() => db.prepare("SELECT id FROM connection_accounts").all()))
          .results
      ).toEqual([]);
      expect(
        (yield* Effect.tryPromise(() => db.prepare("SELECT state FROM connection_grants").all()))
          .results
      ).toEqual([{ state: "cleanup_required" }]);
      const listed = yield* Effect.tryPromise(() => send(db, request(0, "/connections")));
      expect(yield* Effect.tryPromise(() => listed.json())).toMatchObject({
        data: [{ state: "Action required" }],
      });
    })
  ));

it.each([false, true])(
  "refuses late bank results after processing Consent is withdrawn, even when renewed=%s",
  (renewed) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "INSERT INTO consent_history(record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms) VALUES('processing_grant','activation-grant',?,'{}','disclosure','decision',1,1)"
            )
            .bind(users[0])
            .run()
        );
        const { bank, callback } = yield* prepareActivation(db);
        bank.beforeAccounts(
          Effect.tryPromise(() =>
            db
              .prepare(
                "INSERT INTO consent_history(record_type,id,user_id,grant_record_id,session_id,occurred_at_ms) VALUES('processing_withdrawal','activation-withdrawal',?,'activation-grant',?,?)"
              )
              .bind(users[0], sessions[0], DateTime.nowUnsafe().epochMilliseconds)
              .run()
          ).pipe(
            Effect.flatMap(() =>
              renewed
                ? Effect.tryPromise(() =>
                    db
                      .prepare(
                        "INSERT INTO consent_history(record_type,id,user_id,withdrawal_id,grant_record_id,session_id,disclosure_json,occurred_at_ms) VALUES('processing_renewal','activation-renewal',?,'activation-withdrawal','activation-grant',?,'{}',?)"
                      )
                      .bind(users[0], sessions[0], DateTime.nowUnsafe().epochMilliseconds)
                      .run()
                  )
                : Effect.void
            ),
            Effect.asVoid,
            Effect.orDie
          )
        );
        yield* Effect.tryPromise(() => callback());
        expect(bank.exchanges()).toBe(1);
        expect(
          (yield* Effect.tryPromise(() => db.prepare("SELECT id FROM connection_accounts").all()))
            .results
        ).toEqual([]);
        expect(
          (yield* Effect.tryPromise(() => db.prepare("SELECT state FROM connection_grants").all()))
            .results
        ).toEqual([{ state: "cleanup_required" }]);
      })
    )
);

it.each(["Ended", "superseded", "expired"] as const)(
  "refuses an %s attempt before any bank code exchange",
  (scenario) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const { bank, callback, started } = yield* prepareActivation(db);
        if (scenario === "Ended") {
          yield* Effect.tryPromise(() => db.prepare("UPDATE connections SET state='Ended'").run());
        }
        if (scenario === "superseded") yield* Effect.tryPromise(() => start(db));
        if (scenario === "expired") {
          vi.setSystemTime(started.continuation.expiresAt.epochMilliseconds + 1);
        }
        yield* Effect.tryPromise(() => callback());
        expect(bank.exchanges()).toBe(0);
        expect(
          (yield* Effect.tryPromise(() => db.prepare("SELECT id FROM connection_accounts").all()))
            .results
        ).toEqual([]);
      })
    )
);

it("allows a bank return after PAR expiry within the original attempt and preserves Account identities across reauthorization", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const first = yield* prepareActivation(db);
      vi.setSystemTime(DateTime.nowUnsafe().epochMilliseconds + 95000);
      yield* sweepConnectionAttempts({ db, current: DateTime.nowUnsafe().epochMilliseconds });
      yield* Effect.tryPromise(() => first.callback());
      expect(first.bank.exchanges()).toBe(1);
      const read = (): Promise<unknown> =>
        send(db, request(0, `/connections/${first.started.connection.id}/accounts`)).then(
          (response) => response.json()
        );
      const accounts = yield* Effect.tryPromise(read);
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE connections SET state='Action required'").run()
      );
      const second = yield* prepareActivation(db);
      expect(second.started.connection.id).toBe(first.started.connection.id);
      yield* Effect.tryPromise(() => second.callback());
      expect(yield* Effect.tryPromise(read)).toEqual(accounts);
      coordinatorByDatabase.delete(db);
      yield* Effect.tryPromise(() => second.callback());
      expect(second.bank.exchanges()).toBe(1);
    })
  ));
it("binds one bank handoff to the original attempt and never repeats its preparation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      institutionRegistration.enabled = true;
      let calls = 0;
      let publicReference = Option.none<string>();
      const url =
        "https://auth1-api-open-finance-sandbox.ambientesbc.com/auth?client_id=10000000-0000-4000-8000-000000000001&response_type=code&scope=accounts&request_uri=urn:ietf:params:oauth:request_uri:synthetic";
      bankPreparation = Option.some({
        intent: fixtureConsentIntent(),
        prepare: (input) =>
          Effect.gen(function* () {
            calls += 1;
            yield* input.recordConsent("synthetic-consent");
            expect(input.attempt).toBe(Option.getOrThrow(publicReference));
            const stored = yield* Effect.tryPromise(() =>
              db
                .prepare(
                  "SELECT b.verifier,b.state_digest,b.phase,b.intent_json,b.consent_id FROM connection_authorizations b JOIN connection_attempts a ON a.id=b.attempt_id WHERE a.public_reference=?"
                )
                .bind(Option.getOrThrow(publicReference))
                .first()
            );
            const proof = yield* Schema.decodeUnknownEffect(
              Schema.Struct({
                verifier: Schema.String,
                intent_json: Schema.String,
                consent_id: Schema.Literal("synthetic-consent"),
                state_digest: Schema.String,
                phase: Schema.Literal("preparing"),
              })
            )(stored);
            expect(proof.intent_json).toBe(
              yield* Schema.encodeEffect(Schema.fromJsonString(ConnectionConsentIntent))(
                Option.getOrThrow(bankPreparation).intent
              )
            );
            expect(input.challenge).toBe(
              Base64Url.encode(yield* Effect.tryPromise(() => digest(proof.verifier)))
            );
            expect(proof.state_digest).toBe(
              Base64Url.encode(yield* Effect.tryPromise(() => digest(input.state)))
            );
            expect(input.userId).toBe(users[0]);
            expect(input.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
            expect(input.state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
            return { url, expiresAtMilliseconds: DateTime.nowUnsafe().epochMilliseconds + 90000 };
          }).pipe(Effect.orDie),
      });
      const started = yield* Effect.tryPromise(() => start(db));
      if (started.type !== "continue_in_browser") throw new Error("Expected continuation");
      const attempt = new URL(started.continuation.url).searchParams.get("attempt");
      publicReference = Option.fromNullOr(attempt);
      const first = yield* Effect.tryPromise(() =>
        send(db, request(0, "/web/connections/begin", "POST", { attempt }))
      );
      expect(first.status).toBe(200);
      expect(yield* Effect.tryPromise(() => first.json())).toMatchObject({
        phase: "prepared",
        authorization: { url },
      });
      expect(
        (yield* Effect.tryPromise(() =>
          send(db, request(0, "/web/connections/begin", "POST", { attempt }))
        )).status
      ).toBe(404);
      expect(calls).toBe(1);
      institutionRegistration.enabled = false;
      yield* sweepConnectionAttempts({
        db,
        current: DateTime.nowUnsafe().epochMilliseconds + 172800000,
      });
      expect(yield* requiresErasureSuppression({ db, userId: users[0] })).toBe(true);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT verifier,consent_id FROM connection_authorizations").first()
        )
      ).toEqual({
        verifier: null,
        consent_id: "synthetic-consent",
      });
    })
  ));

it("settles an uncertain bank submission without retaining its verifier or allowing a retry", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      institutionRegistration.enabled = true;
      let calls = 0;
      bankPreparation = Option.some({
        intent: fixtureConsentIntent(),
        prepare: () => {
          calls += 1;
          return Effect.fail(new ConnectionAuthorizationUnavailable());
        },
      });
      const started = yield* Effect.tryPromise(() => start(db));
      if (started.type !== "continue_in_browser") throw new Error("Expected continuation");
      const attempt = new URL(started.continuation.url).searchParams.get("attempt");
      const response = yield* Effect.tryPromise(() =>
        send(db, request(0, "/web/connections/begin", "POST", { attempt }))
      );
      expect(response.status).toBe(200);
      expect(yield* Effect.tryPromise(() => response.json())).toMatchObject({ phase: "failed" });
      const retained = yield* Effect.tryPromise(() =>
        db.prepare("SELECT verifier FROM connection_authorizations").all()
      );
      expect(retained.results).toEqual([{ verifier: null }]);
      expect(
        (yield* Effect.tryPromise(() =>
          send(db, request(0, "/web/connections/begin", "POST", { attempt }))
        )).status
      ).toBe(404);
      expect(calls).toBe(1);
    })
  ));

it("prepares a browser authorization once without activating the Connection", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      institutionRegistration.enabled = true;
      const started = yield* Effect.tryPromise(() => start(db));
      if (started.type !== "continue_in_browser") throw new Error("Expected browser continuation");
      const attempt = new URL(started.continuation.url).searchParams.get("attempt");
      const foreign = yield* Effect.tryPromise(() =>
        send(db, request(1, "/web/connections/begin", "POST", { attempt }))
      );
      expect(foreign.status).toBe(404);
      const prepared = yield* Effect.tryPromise(() =>
        send(db, request(0, "/web/connections/begin", "POST", { attempt }))
      );
      expect(prepared.status).toBe(200);
      expect(prepared.headers.get("cache-control")).toBe("no-store");
      expect(yield* Effect.tryPromise(() => prepared.json())).toEqual({
        connection: started.connection,
        institutionName: "Bancolombia",
        expiresAt: DateTime.formatIso(started.continuation.expiresAt),
        phase: "prepared",
      });
      const replay = yield* Effect.tryPromise(() =>
        send(db, request(0, "/web/connections/begin", "POST", { attempt }))
      );
      expect(replay.status).toBe(404);
      const progress = yield* Effect.tryPromise(() =>
        send(db, request(0, `/web/connections/review?attempt=${attempt}`))
      );
      expect(yield* Effect.tryPromise(() => progress.json())).toMatchObject({ phase: "prepared" });
      const inspected = yield* Effect.tryPromise(() =>
        send(db, request(0, `/connections/${started.connection.id}`))
      );
      expect(yield* Effect.tryPromise(() => inspected.json())).toEqual({
        data: started.connection,
        next: [],
      });
    })
  ));
it.each(["expired", "stale-session", "revoked-session", "disabled-institution"] as const)(
  "refuses %s browser preparation without consuming the attempt",
  (condition) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        institutionRegistration.enabled = true;
        const started = yield* Effect.tryPromise(() => start(db));
        if (started.type !== "continue_in_browser") {
          throw new Error("Expected browser continuation");
        }
        const attempt = new URL(started.continuation.url).searchParams.get("attempt");
        if (condition === "expired") {
          vi.setSystemTime(started.continuation.expiresAt.epochMilliseconds);
        }
        if (condition === "stale-session") {
          vi.setSystemTime(started.continuation.expiresAt.epochMilliseconds - 2000);
        }
        if (condition === "revoked-session") {
          yield* Effect.tryPromise(() =>
            db
              .prepare("UPDATE web_sessions SET revoked_at_ms = ? WHERE id = ?")
              .bind(DateTime.nowUnsafe().epochMilliseconds, sessions[0])
              .run()
          );
        }
        if (condition === "disabled-institution") {
          institutionRegistration.enabled = false;
        }
        const refused = yield* Effect.tryPromise(() =>
          send(db, request(0, "/web/connections/begin", "POST", { attempt }))
        );
        expect(refused.status).toBe(condition === "revoked-session" ? 401 : 404);
        expect(
          yield* Effect.tryPromise(() => db.prepare("SELECT status FROM connection_attempts").all())
        ).toMatchObject({ results: [{ status: "pending" }] });
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT id AS attempt_id FROM connection_attempts WHERE prepared_session_id IS NOT NULL"
              )
              .all()
          )
        ).toMatchObject({ results: [] });
      })
    )
);
it("refuses hostile browser input and origins without consuming a live attempt", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      institutionRegistration.enabled = true;
      const started = yield* Effect.tryPromise(() => start(db));
      if (started.type !== "continue_in_browser") throw new Error("Expected browser continuation");
      const attempt = new URL(started.continuation.url).searchParams.get("attempt");
      const crossOrigin = request(0, "/web/connections/begin", "POST", { attempt });
      crossOrigin.headers.set("origin", "https://attacker.example");
      const originless = request(0, "/web/connections/begin", "POST", { attempt });
      originless.headers.delete("origin");
      const anonymous = request(0, "/web/connections/begin", "POST", { attempt });
      anonymous.headers.delete("cookie");
      expect((yield* Effect.tryPromise(() => send(db, crossOrigin))).status).toBe(403);
      expect((yield* Effect.tryPromise(() => send(db, originless))).status).toBe(403);
      expect((yield* Effect.tryPromise(() => send(db, anonymous))).status).toBe(401);
      for (const candidate of [
        request(0, "/web/connections/begin"),
        request(0, "/web/connections/review", "POST", { attempt }),
      ]) {
        expect((yield* Effect.tryPromise(() => send(db, candidate))).status).toBe(405);
      }
      expect(
        (yield* Effect.tryPromise(() =>
          send(db, request(0, "/web/connections/other", "POST", { attempt }))
        )).status
      ).toBe(404);
      const unknown = yield* handleConnectionBrowserRequest({
        request: request(0, "/web/connections/other", "POST", { attempt }),
        db,
        browserOrigin: "https://app.fidyapp.com",
        coordinator: {
          getByName: () => {
            throw new Error("No coordinator for an unrecognized transport");
          },
        },
      });
      expect(unknown.status).toBe(404);
      const hostile = [
        request(0, "/web/connections/begin", "POST", { attempt: "invalid" }),
        request(0, "/web/connections/begin", "POST", {
          attempt,
          authorizationCode: "must-not-be-accepted",
        }),
        request(0, "/web/connections/begin", "POST", { attempt, padding: "x".repeat(2048) }),
        request(0, `/web/connections/begin?attempt=${attempt}`, "POST", { attempt }),
        request(0, `/web/connections/review?attempt=${attempt}&attempt=${attempt}`),
      ];
      for (const candidate of hostile) {
        expect((yield* Effect.tryPromise(() => send(db, candidate))).status).toBe(400);
      }
      const owner = yield* Effect.tryPromise(() =>
        send(db, request(0, "/web/connections/begin", "POST", { attempt }))
      );
      expect(owner.status).toBe(200);
    })
  ));
it("forwards Connection browser credentials and a server-authored trace without caller metadata", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (const candidate of [
        request(0, "/web/connections/review?attempt=10000000-0000-4000-8000-000000000001"),
        request(0, "/web/connections/begin", "POST", {
          attempt: "10000000-0000-4000-8000-000000000001",
        }),
      ]) {
        candidate.headers.set("authorization", "Bearer must-not-reach-Core");
        candidate.headers.set("x-user-id", users[1]);
        candidate.headers.set("x-canonical-source", "must-not-reach-Core");
        const hostileParent = `00-${"1".repeat(32)}-${"2".repeat(16)}-01`;
        candidate.headers.set("traceparent", hostileParent);
        candidate.headers.set(workerInternalTraceHeader, hostileParent);
        const response = yield* Effect.tryPromise(() =>
          publicWorker.fetch(candidate, {
            BROWSER_ORIGIN: "https://app.fidyapp.com",
            LOCAL_CANONICAL_READ_BEARER: "",
            PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
            RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
            CORE: {
              fetch: (internal) => {
                const forwarded = new Request(internal);
                expect(Array.from(forwarded.headers.keys()).sort()).toEqual([
                  "content-type",
                  "cookie",
                  "fidy-session-binding",
                  "origin",
                  workerInternalTraceHeader,
                ]);
                expect(forwarded.headers.get(workerInternalTraceHeader)).toMatch(
                  /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/u
                );
                expect(forwarded.headers.get(workerInternalTraceHeader)).not.toBe(hostileParent);
                expect(forwarded.headers.get("cookie")).toBe(candidate.headers.get("cookie"));
                expect(forwarded.headers.get("fidy-session-binding")).toBe(
                  candidate.headers.get("fidy-session-binding")
                );
                expect(forwarded.headers.get("origin")).toBe(candidate.headers.get("origin"));
                expect(forwarded.headers.get("content-type")).toBe(
                  candidate.headers.get("content-type") ?? ""
                );
                return Promise.resolve(new Response(null, { status: 204 }));
              },
            },
          })
        );
        expect(response.status).toBe(204);
      }
    })
  ));
it("commits only one concurrent browser preparation and retires old continuation progress", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      institutionRegistration.enabled = true;
      let bankCalls = 0;
      bankPreparation = Option.some({
        intent: fixtureConsentIntent(),
        prepare: () => {
          bankCalls++;
          return Effect.fail(new ConnectionAuthorizationUnavailable());
        },
      });
      const started = yield* Effect.tryPromise(() => start(db));
      if (started.type !== "continue_in_browser") throw new Error("Expected browser continuation");
      const attempt = new URL(started.continuation.url).searchParams.get("attempt");
      const parallel = yield* Effect.tryPromise(() =>
        Promise.all(
          Array.from({ length: 3 }, () =>
            send(db, request(0, "/web/connections/begin", "POST", { attempt }))
          )
        )
      );
      expect(parallel.filter((response) => response.status === 200)).toHaveLength(1);
      expect(parallel.every((response) => [200, 404, 429].includes(response.status))).toBe(true);
      expect(bankCalls).toBe(1);
      const replacement = yield* Effect.tryPromise(() => start(db));
      expect(replacement.connection.id).toBe(started.connection.id);
      const retired = yield* Effect.tryPromise(() =>
        send(db, request(0, `/web/connections/review?attempt=${attempt}`))
      );
      expect(retired.status).toBe(404);
    })
  ));
it("rolls back browser preparation when Audit fails and allows a safe retry", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      institutionRegistration.enabled = true;
      const started = yield* Effect.tryPromise(() => start(db));
      if (started.type !== "continue_in_browser") throw new Error("Expected browser continuation");
      const attempt = new URL(started.continuation.url).searchParams.get("attempt");
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "CREATE TRIGGER refuse_browser_audit BEFORE INSERT ON audit_entries WHEN NEW.record_type='credential_call' AND NEW.operation = 'connections.beginContinuation' BEGIN SELECT RAISE(ABORT, 'fixture_evidence_unavailable'); END"
          )
          .run()
      );
      const refused = yield* Effect.tryPromise(() =>
        send(db, request(0, "/web/connections/begin", "POST", { attempt }))
      );
      expect(refused.status).toBe(503);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT id AS attempt_id FROM connection_attempts WHERE prepared_session_id IS NOT NULL"
            )
            .all()
        )
      ).toMatchObject({ results: [] });
      yield* Effect.tryPromise(() => db.prepare("DROP TRIGGER refuse_browser_audit").run());
      const retried = yield* Effect.tryPromise(() =>
        send(db, request(0, "/web/connections/begin", "POST", { attempt }))
      );
      expect(retried.status).toBe(200);
    })
  ));
it.each(["session-revocation", "consent-withdrawal"] as const)(
  "rechecks %s after browser admission before preparation commits",
  (change) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        institutionRegistration.enabled = true;
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "INSERT INTO consent_history (record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms) VALUES ('processing_grant','browser-grant', ?, '{}', 'disclosure', 'decision', 1, 1)"
            )
            .bind(users[0])
            .run()
        );
        const started = yield* Effect.tryPromise(() => start(db));
        if (started.type !== "continue_in_browser") {
          throw new Error("Expected browser continuation");
        }
        const attempt = new URL(started.continuation.url).searchParams.get("attempt");
        const response = yield* Effect.tryPromise(() =>
          send(db, request(0, "/web/connections/begin", "POST", { attempt }), (database) =>
            change === "session-revocation"
              ? database
                  .prepare("UPDATE web_sessions SET revoked_at_ms = ? WHERE id = ?")
                  .bind(DateTime.nowUnsafe().epochMilliseconds, sessions[0])
                  .run()
              : database
                  .prepare(
                    "INSERT INTO consent_history(record_type,id,user_id,grant_record_id,session_id,occurred_at_ms) VALUES ('processing_withdrawal','browser-withdrawn', ?, 'browser-grant', ?, ?)"
                  )
                  .bind(users[0], sessions[0], DateTime.nowUnsafe().epochMilliseconds)
                  .run()
          )
        );
        expect(response.status).toBe(404);
        expect(
          yield* Effect.tryPromise(() => db.prepare("SELECT status FROM connection_attempts").all())
        ).toMatchObject({ results: [{ status: "pending" }] });
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT id AS attempt_id FROM connection_attempts WHERE prepared_session_id IS NOT NULL"
              )
              .all()
          )
        ).toMatchObject({ results: [] });
      })
    )
);
it("shares canonical User request pressure before browser work is queued", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      institutionRegistration.enabled = true;
      const started = yield* Effect.tryPromise(() => start(db));
      if (started.type !== "continue_in_browser") throw new Error("Expected browser continuation");
      const attempt = new URL(started.continuation.url).searchParams.get("attempt");
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare("INSERT INTO canonical_request_leases VALUES ('occupied-one', ?, ?)")
            .bind(users[0], DateTime.nowUnsafe().epochMilliseconds + 90000),
          db
            .prepare("INSERT INTO canonical_request_leases VALUES ('occupied-two', ?, ?)")
            .bind(users[0], DateTime.nowUnsafe().epochMilliseconds + 90000),
        ])
      );
      expect(
        (yield* Effect.tryPromise(() =>
          send(db, request(0, "/web/connections/begin", "POST", { attempt }))
        )).status
      ).toBe(429);
      expect(
        (yield* Effect.tryPromise(() =>
          send(db, request(0, `/web/connections/review?attempt=${attempt}`))
        )).status
      ).toBe(429);
      yield* Effect.tryPromise(() =>
        db.prepare("DELETE FROM canonical_request_leases WHERE user_id = ?").bind(users[0]).run()
      );
      expect(
        (yield* Effect.tryPromise(() =>
          send(db, request(0, "/web/connections/begin", "POST", { attempt }))
        )).status
      ).toBe(200);
    })
  ));
it("isolates ready and prepared browser review from a different User holding the locator", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      institutionRegistration.enabled = true;
      const started = yield* Effect.tryPromise(() => start(db));
      if (started.type !== "continue_in_browser") throw new Error("Expected browser continuation");
      const attempt = new URL(started.continuation.url).searchParams.get("attempt");
      for (const phase of ["ready", "prepared"] as const) {
        if (phase === "prepared") {
          expect(
            (yield* Effect.tryPromise(() =>
              send(db, request(0, "/web/connections/begin", "POST", { attempt }))
            )).status
          ).toBe(200);
        }
        const foreign = yield* Effect.tryPromise(() =>
          send(db, request(1, `/web/connections/review?attempt=${attempt}`))
        );
        expect(foreign.status).toBe(404);
        expect(yield* Effect.tryPromise(() => foreign.json())).toEqual({
          error: { code: "continuation_unavailable" },
        });
        const owned = yield* Effect.tryPromise(() =>
          send(db, request(0, `/web/connections/review?attempt=${attempt}`))
        );
        expect(owned.status).toBe(200);
        expect(yield* Effect.tryPromise(() => owned.json())).toEqual({
          connection: started.connection,
          institutionName: "Bancolombia",
          expiresAt: DateTime.formatIso(started.continuation.expiresAt),
          phase,
        });
      }
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT id FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit WHERE user_id = ? AND operation = 'connections.reviewContinuation' AND outcome = 'accepted'"
            )
            .bind(users[1])
            .all()
        )
      ).toMatchObject({ results: [] });
    })
  ));
it("reviews a live browser continuation without granting institution authority", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      institutionRegistration.enabled = true;
      const started = yield* Effect.tryPromise(() => start(db));
      if (started.type !== "continue_in_browser") throw new Error("Expected browser continuation");
      const attempt = new URL(started.continuation.url).searchParams.get("attempt");
      const review = yield* Effect.tryPromise(() =>
        send(db, request(0, `/web/connections/review?attempt=${attempt}`))
      );
      expect(review.status).toBe(200);
      expect(review.headers.get("cache-control")).toContain("no-store");
      expect(yield* Effect.tryPromise(() => review.json())).toEqual({
        connection: started.connection,
        institutionName: "Bancolombia",
        expiresAt: DateTime.formatIso(started.continuation.expiresAt),
        phase: "ready",
      });
      const listed = yield* Effect.tryPromise(() =>
        send(db, request(0, `/connections/${started.connection.id}`))
      );
      expect(yield* Effect.tryPromise(() => listed.json())).toEqual({
        data: started.connection,
        next: [],
      });
    })
  ));
it("replaces an attempt at its exact expiry without changing stable Connection identity", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      institutionRegistration.enabled = true;
      const first = yield* Effect.tryPromise(() => start(db));
      if (first.type !== "continue_in_browser") throw new Error("Expected browser continuation");
      vi.setSystemTime(first.continuation.expiresAt.epochMilliseconds - 1000);
      const replacement = yield* Effect.tryPromise(() => start(db));
      if (replacement.type !== "continue_in_browser") {
        throw new Error("Expected browser continuation");
      }
      expect(replacement.connection.id).toBe(first.connection.id);
      expect(replacement.continuation.url).not.toBe(first.continuation.url);
      expect(replacement.continuation.expiresAt.epochMilliseconds).toBe(
        first.continuation.expiresAt.epochMilliseconds + 600000
      );
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT status FROM connection_attempts ORDER BY created_at_ms").all()
        )
      ).toMatchObject({ results: [{ status: "invalidated" }, { status: "pending" }] });
    })
  ));
it("keeps one stable identity under concurrent starts and isolates another User", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      institutionRegistration.enabled = true;
      const starts = yield* Effect.tryPromise(() =>
        Promise.all(
          Array.from({ length: 3 }, () =>
            send(db, request(0, "/connections", "POST", { institutionId: "bancolombia" }))
          )
        )
      );
      expect(starts.some((response) => response.status === 200)).toBe(true);
      expect(starts.every((response) => response.status === 200 || response.status === 429)).toBe(
        true
      );
      const successes = yield* Effect.forEach(
        starts.filter((response) => response.status === 200),
        decodeStartResponse
      );
      const owned = yield* Effect.tryPromise(() => start(db));
      expect(successes.every((value) => value.connection.id === owned.connection.id)).toBe(true);
      const foreign = yield* Effect.tryPromise(() =>
        send(db, request(1, `/connections/${owned.connection.id}`))
      );
      expect(foreign.status).toBe(404);
      expect(yield* Effect.tryPromise(() => foreign.json())).toMatchObject({
        error: { code: "not_found" },
      });
      const foreignList = yield* Effect.tryPromise(() => send(db, request(1, "/connections")));
      expect(yield* Effect.tryPromise(() => foreignList.json())).toEqual({ data: [], next: [] });
      const second = yield* Effect.tryPromise(() => start(db, 1));
      expect(second.connection.id).not.toBe(owned.connection.id);
      const original = yield* Effect.tryPromise(() =>
        send(db, request(0, `/connections/${owned.connection.id}`))
      );
      expect(yield* Effect.tryPromise(() => original.json())).toEqual({
        data: owned.connection,
        next: [],
      });
      const ownInstitutions = yield* Effect.tryPromise(() => send(db, request(0, "/institutions")));
      expect(yield* Effect.tryPromise(() => ownInstitutions.json())).toEqual({
        data: [
          {
            id: "bancolombia",
            displayName: "Bancolombia",
            availability: "available",
            connection: { id: owned.connection.id, state: "Connecting" },
          },
        ],
        next: [],
      });
    })
  ));
it.each([
  ["bancolombia", 400],
  ["unknown", 404],
] as const)(
  "refuses unavailable institution %s without creating either lifecycle row",
  (institutionId, status) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const response = yield* Effect.tryPromise(() =>
          send(db, request(0, "/connections", "POST", { institutionId }))
        );
        expect(response.status).toBe(status);
        expect(yield* Effect.tryPromise(() => response.json())).toMatchObject({
          error: { message: "Institution unavailable." },
        });
        const list = yield* Effect.tryPromise(() => send(db, request(0, "/connections")));
        expect(yield* Effect.tryPromise(() => list.json())).toEqual({ data: [], next: [] });
        expect(
          yield* Effect.tryPromise(() => db.prepare("SELECT id FROM connection_attempts").all())
        ).toMatchObject({
          results: [],
        });
      })
    )
);
it("returns an Active association without starting another attempt", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      institutionRegistration.enabled = true;
      const original = yield* Effect.tryPromise(() => start(db));
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "UPDATE connection_attempts SET status = 'consumed', consumed_at_ms = ? WHERE EXISTS(SELECT 1 FROM connections c WHERE c.id=connection_attempts.connection_id AND c.user_id=?) AND status = 'pending'"
          )
          .bind(DateTime.nowUnsafe().epochMilliseconds, users[0])
          .run()
      );
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE connections SET state = 'Active' WHERE user_id = ?").bind(users[0]).run()
      );
      expect(yield* Effect.tryPromise(() => start(db))).toEqual({
        type: "already_connected",
        connection: { ...original.connection, state: "Active" },
      });
    })
  ));
const seedPAT = (
  db: D1Database,
  input: Readonly<{
    token: string;
    scope: "read" | "write";
    id: string;
  }>
): Effect.Effect<void, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const { token, scope, id } = input;
    const current = DateTime.nowUnsafe().epochMilliseconds;
    const credentialDigest3 = yield* Effect.tryPromise(() => digest(token));
    const scopesJson = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.Array(Schema.String))
    )([scope]);
    yield* Effect.tryPromise(() =>
      db
        .prepare(`INSERT INTO pats (id, user_id, short_id, bearer_digest, recipient_label, scopes_json, lifetime_days,
    created_at_ms, issued_at_ms, expires_at_ms, request_id)
    VALUES (?, ?, ?, ?, 'Connection capability fixture', ?, 7, ?, ?, ?, ?)`)
        .bind(
          id,
          users[0],
          token.slice(4, 12),
          credentialDigest3,
          scopesJson,
          current,
          current,
          current + 7 * 86400000,
          id.replace("8000", "9000")
        )
        .run()
    );
  });
it("uses read and write capabilities from the shared authorization algebra", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      institutionRegistration.enabled = true;
      const readToken = `fin_${"r".repeat(8)}_${"a".repeat(43)}`;
      const writeToken = `fin_${"w".repeat(8)}_${"b".repeat(43)}`;
      yield* seedPAT(db, {
        token: readToken,
        scope: "read",
        id: "10000000-0000-4000-8000-000000000081",
      });
      yield* seedPAT(db, {
        token: writeToken,
        scope: "write",
        id: "10000000-0000-4000-8000-000000000082",
      });
      const asPAT = (
        token: string,
        path: string,
        ...args: [method?: string, body?: object]
      ): Request => {
        const [method = "GET", body = {}] = args;
        const value = request(0, path, method, method === "GET" ? undefined : body);
        value.headers.delete("cookie");
        value.headers.set("authorization", `Bearer ${token}`);
        return value;
      };
      const deniedStart = yield* Effect.tryPromise(() =>
        send(db, asPAT(readToken, "/connections", "POST", { institutionId: "bancolombia" }))
      );
      expect(deniedStart.status).toBe(403);
      const allowedRead = yield* Effect.tryPromise(() =>
        send(db, asPAT(readToken, "/institutions"))
      );
      expect(allowedRead.status).toBe(200);
      const deniedRead = yield* Effect.tryPromise(() =>
        send(db, asPAT(writeToken, "/connections"))
      );
      expect(deniedRead.status).toBe(403);
      const allowedStart = yield* Effect.tryPromise(() =>
        send(db, asPAT(writeToken, "/connections", "POST", { institutionId: "bancolombia" }))
      );
      expect(allowedStart.status).toBe(200);
      expect(yield* Effect.tryPromise(() => allowedStart.json())).toMatchObject({
        data: { type: "continue_in_browser" },
      });
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE pats SET revoked_at_ms = ? WHERE id = ?")
          .bind(DateTime.nowUnsafe().epochMilliseconds, "10000000-0000-4000-8000-000000000082")
          .run()
      );
      const revoked = yield* Effect.tryPromise(() =>
        send(db, asPAT(writeToken, "/connections", "POST", { institutionId: "bancolombia" }))
      );
      expect(revoked.status).toBe(401);
    })
  ));
it("rolls back Connection, attempt and success Audit when the final evidence write fails", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      institutionRegistration.enabled = true;
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "CREATE TRIGGER refuse_connection_audit BEFORE INSERT ON audit_entries WHEN NEW.record_type='credential_call' AND NEW.operation = 'connections.connectInstitution' AND NEW.outcome = 'accepted' BEGIN SELECT RAISE(ABORT, 'fixture_evidence_unavailable'); END"
          )
          .run()
      );
      const response = yield* Effect.tryPromise(() =>
        send(db, request(0, "/connections", "POST", { institutionId: "bancolombia" }))
      );
      expect(response.status).toBe(503);
      const listed = yield* Effect.tryPromise(() => send(db, request(0, "/connections")));
      expect(yield* Effect.tryPromise(() => listed.json())).toEqual({ data: [], next: [] });
      expect(
        yield* Effect.tryPromise(() => db.prepare("SELECT id FROM connection_attempts").all())
      ).toMatchObject({
        results: [],
      });
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT id FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms,oauth_connection_id,oauth_credential_id,hosted_turn_id FROM audit_entries WHERE record_type='credential_call') AS pat_audit WHERE operation = 'connections.connectInstitution' AND outcome = 'accepted'"
            )
            .all()
        )
      ).toMatchObject({ results: [] });
    })
  ));
it("composes a Connection start in the canonical atomic batch and refuses duplicate targets before commit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      institutionRegistration.enabled = true;
      const call = (index: number): object => ({
        callId: `20000000-0000-4000-8000-00000000000${index}`,
        operation: "connections.connectInstitution",
        input: { payload: { institutionId: "bancolombia" } },
      });
      const refused = yield* Effect.tryPromise(() =>
        send(db, request(0, "/operations/atomic-batch", "POST", { calls: [call(1), call(2)] }))
      );
      expect(refused.status).toBe(400);
      const listed = yield* Effect.tryPromise(() => send(db, request(0, "/connections")));
      expect(yield* Effect.tryPromise(() => listed.json())).toEqual({ data: [], next: [] });
      const accepted = yield* Effect.tryPromise(() =>
        send(db, request(0, "/operations/atomic-batch", "POST", { calls: [call(1)] }))
      );
      expect(accepted.status).toBe(200);
      expect(yield* Effect.tryPromise(() => accepted.json())).toMatchObject({
        data: {
          results: [
            {
              operation: "connections.connectInstitution",
              output: { data: { type: "continue_in_browser" } },
            },
          ],
        },
      });
    })
  ));
it("persists immutable expiry, same-User ownership, and terminal single-use attempt state", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      institutionRegistration.enabled = true;
      const started = yield* Effect.tryPromise(() => start(db));
      yield* Effect.tryPromise(() =>
        expect(
          db.prepare("UPDATE connection_attempts SET expires_at_ms = expires_at_ms + 1").run()
        ).rejects.toThrow()
      );
      yield* Effect.tryPromise(() =>
        expect(
          db
            .prepare("UPDATE connection_attempts SET connection_id = ?")
            .bind("foreign-connection")
            .run()
        ).rejects.toThrow()
      );
      yield* Effect.tryPromise(() =>
        expect(
          db
            .prepare(
              "UPDATE connection_attempts SET status = 'consumed', consumed_at_ms = expires_at_ms"
            )
            .run()
        ).rejects.toThrow()
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE connection_attempts SET status = 'consumed', consumed_at_ms = ?")
          .bind(DateTime.nowUnsafe().epochMilliseconds)
          .run()
      );
      yield* Effect.tryPromise(() =>
        expect(
          db
            .prepare("UPDATE connection_attempts SET status = 'pending', consumed_at_ms = NULL")
            .run()
        ).rejects.toThrow()
      );
      yield* Effect.tryPromise(() =>
        expect(
          db
            .prepare("UPDATE connection_attempts SET status = 'consumed', consumed_at_ms = ?")
            .bind(DateTime.nowUnsafe().epochMilliseconds + 1)
            .run()
        ).rejects.toThrow()
      );
      yield* Effect.tryPromise(() =>
        expect(
          db
            .prepare(
              "INSERT INTO connections (id,user_id,institution_id,state,created_at_ms,updated_at_ms) VALUES ('10000000-0000-4000-8000-000000000091',?,'bancolombia','Connecting',?,?)"
            )
            .bind(
              users[0],
              DateTime.nowUnsafe().epochMilliseconds,
              DateTime.nowUnsafe().epochMilliseconds
            )
            .run()
        ).rejects.toThrow()
      );
      const next = yield* Effect.tryPromise(() => start(db));
      expect(next.connection.id).toBe(started.connection.id);
      if (next.type !== "continue_in_browser" || started.type !== "continue_in_browser") {
        throw new Error("Expected browser continuations");
      }
      expect(next.continuation.url).not.toBe(started.continuation.url);
    })
  ));
it.each(["Action required", "Ended"] as const)(
  "starts a fresh %s reauthorization attempt with the same identity",
  (state) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        institutionRegistration.enabled = true;
        const original = yield* Effect.tryPromise(() => start(db));
        yield* Effect.tryPromise(() =>
          db
            .prepare("UPDATE connections SET state = ? WHERE user_id = ?")
            .bind(state, users[0])
            .run()
        );
        const next = yield* Effect.tryPromise(() => start(db));
        expect(next.connection.id).toBe(original.connection.id);
        if (next.type !== "continue_in_browser" || original.type !== "continue_in_browser") {
          throw new Error("Expected browser continuations");
        }
        expect(next.continuation.url).not.toBe(original.continuation.url);
      })
    )
);
it("refuses malformed and cross-origin starts before any lifecycle effect", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      institutionRegistration.enabled = true;
      const malformed = yield* Effect.tryPromise(() =>
        send(db, request(0, "/connections", "POST", { institutionId: "../bancolombia" }))
      );
      expect(malformed.status).toBe(400);
      const crossOrigin = request(0, "/connections", "POST", { institutionId: "bancolombia" });
      crossOrigin.headers.set("origin", "https://attacker.example");
      expect((yield* Effect.tryPromise(() => send(db, crossOrigin))).status).toBe(403);
      const anonymous = request(0, "/connections");
      anonymous.headers.delete("cookie");
      expect((yield* Effect.tryPromise(() => send(db, anonymous))).status).toBe(401);
      const list = yield* Effect.tryPromise(() => send(db, request(0, "/connections")));
      expect(yield* Effect.tryPromise(() => list.json())).toEqual({ data: [], next: [] });
    })
  ));
it("removes expired attempts after their bounded retention while retaining the stable Connection", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      institutionRegistration.enabled = true;
      const original = yield* Effect.tryPromise(() => start(db));
      if (original.type !== "continue_in_browser") throw new Error("Expected browser continuation");
      vi.setSystemTime(original.continuation.expiresAt.epochMilliseconds + 86400000);
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE web_sessions SET idle_expires_at_ms = ? WHERE user_id = ?")
          .bind(DateTime.nowUnsafe().epochMilliseconds + 3600000, users[0])
          .run()
      );
      const returned = yield* Effect.tryPromise(() => start(db));
      expect(returned.connection.id).toBe(original.connection.id);
      expect(
        yield* Effect.tryPromise(() => db.prepare("SELECT status FROM connection_attempts").all())
      ).toMatchObject({
        results: [{ status: "pending" }],
      });
    })
  ));

it("scheduled retention clears abandoned proof after Consent withdrawal while retaining bank suppression evidence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      institutionRegistration.enabled = true;
      bankPreparation = Option.some({
        intent: fixtureConsentIntent(),
        prepare: (input) =>
          input.recordConsent("synthetic-consent").pipe(
            Effect.as({
              url: "https://auth1-api-open-finance-sandbox.ambientesbc.com/auth?client_id=10000000-0000-4000-8000-000000000001&response_type=code&scope=accounts&request_uri=urn:ietf:params:oauth:request_uri:synthetic",
              expiresAtMilliseconds: DateTime.nowUnsafe().epochMilliseconds + 90000,
            })
          ),
      });
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO consent_history (record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms) VALUES ('processing_grant','retention-grant', ?, '{}', 'disclosure', 'decision', 1, 1)"
          )
          .bind(users[0])
          .run()
      );
      const started = yield* Effect.tryPromise(() => start(db));
      if (started.type !== "continue_in_browser") throw new Error("Expected browser continuation");
      const attempt = new URL(started.continuation.url).searchParams.get("attempt");
      expect(
        (yield* Effect.tryPromise(() =>
          send(db, request(0, "/web/connections/begin", "POST", { attempt }))
        )).status
      ).toBe(200);
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO consent_history(record_type,id,user_id,grant_record_id,session_id,occurred_at_ms) VALUES ('processing_withdrawal','retention-withdrawn', ?, 'retention-grant', ?, ?)"
          )
          .bind(users[0], sessions[0], DateTime.nowUnsafe().epochMilliseconds)
          .run()
      );
      const tick = (): Promise<void> =>
        scheduledCoreWorker
          .scheduled(
            {
              cron: "* * * * *",
              scheduledTime:
                Math.floor(DateTime.nowUnsafe().epochMilliseconds / 3_600_000) * 3_600_000,
              noRetry: () => undefined,
            },
            {
              DB: db,
              AI: { run: () => Promise.reject(new Error("unused inference")) },
              USER_TRANSACTION_COORDINATOR: {
                getByName: () => ({ fetch: () => Promise.reject(new Error("unused coordinator")) }),
              },
              HOSTED_AI_MODEL: approvedWorkersAiModel,
              BROWSER_ORIGIN: "https://app.fidyapp.com",
              CLOUDFLARE_ACCESS_AUDIENCE: "",
              CLOUDFLARE_ACCESS_ISSUER: "",
              CONTRACT_DIGEST: "a".repeat(64),
              RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
              KAPSO_API_KEY: "",
              WHATSAPP_SANDBOX_PHONE_NUMBER_ID: "",
              KAPSO_WEBHOOK_SECRET: "",
              WHATSAPP_BUSINESS_PORTFOLIO_ID: "portfolio",
              WOMPI_ENVIRONMENT: "",
              WOMPI_INTEGRITY_SECRET: "",
              WOMPI_PRIVATE_KEY: "",
              WOMPI_PUBLIC_KEY: "",
            }
          )
          .catch(() => undefined);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT phase FROM connection_authorizations").all()
        )).results
      ).toEqual([{ phase: "prepared" }]);
      vi.setSystemTime(started.continuation.expiresAt.epochMilliseconds);
      yield* sweepConnectionAttempts({ db, current: DateTime.nowUnsafe().epochMilliseconds });
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT phase,verifier,handoff_url FROM connection_authorizations").all()
        )).results
      ).toEqual([{ phase: "failed", verifier: null, handoff_url: null }]);
      vi.setSystemTime(started.continuation.expiresAt.epochMilliseconds + 86400000 - 1);
      yield* Effect.tryPromise(tick);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT id AS attempt_id FROM connection_attempts WHERE prepared_session_id IS NOT NULL"
            )
            .all()
        )).results
      ).toHaveLength(1);
      vi.setSystemTime(started.continuation.expiresAt.epochMilliseconds + 86400000);
      yield* Effect.tryPromise(tick);
      expect(
        (yield* Effect.tryPromise(() => db.prepare("SELECT id FROM connection_attempts").all()))
          .results
      ).toHaveLength(1);
      expect(yield* requiresErasureSuppression({ db, userId: users[0] })).toBe(true);
      expect(
        yield* Effect.tryPromise(() => db.prepare("SELECT id FROM connections").all())
      ).toMatchObject({ results: [{ id: started.connection.id }] });
    })
  ));

it("bounds independent retention and preserves live attempts and stable Connections", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      institutionRegistration.enabled = true;
      const started = yield* Effect.tryPromise(() => start(db));
      const current = DateTime.nowUnsafe().epochMilliseconds;
      yield* Effect.tryPromise(() =>
        db
          .prepare(`INSERT INTO connection_attempts
        (id,connection_id,public_reference,status,created_at_ms,expires_at_ms)
        WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 130)
        SELECT 'retention-' || n, ?, 'retention-reference-' || n, 'invalidated', ?, ? FROM seq`)
          .bind(started.connection.id, current - 86400000 - 600000, current - 86400000)
          .run()
      );
      yield* sweepConnectionAttempts({ db, current });
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT id FROM connection_attempts WHERE status = 'invalidated'").all()
        )).results
      ).toHaveLength(2);
      yield* sweepConnectionAttempts({ db, current });
      expect(
        (yield* Effect.tryPromise(() => db.prepare("SELECT status FROM connection_attempts").all()))
          .results
      ).toEqual([{ status: "pending" }]);
      expect(
        (yield* Effect.tryPromise(() => db.prepare("SELECT id FROM connections").all())).results
      ).toEqual([{ id: started.connection.id }]);
    })
  ));

it("erases only the owning User's authorization proof with frozen writes and atomic failure recovery", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      institutionRegistration.enabled = true;
      bankPreparation = Option.some({
        intent: fixtureConsentIntent(),
        prepare: (input) =>
          input.recordConsent("synthetic-consent").pipe(
            Effect.as({
              url: "https://auth1-api-open-finance-sandbox.ambientesbc.com/auth?client_id=10000000-0000-4000-8000-000000000001&response_type=code&scope=accounts&request_uri=urn:ietf:params:oauth:request_uri:synthetic",
              expiresAtMilliseconds: DateTime.nowUnsafe().epochMilliseconds + 90000,
            })
          ),
      });
      for (const index of [0, 1]) {
        const connection = yield* Effect.tryPromise(() => start(db, index));
        if (connection.type !== "continue_in_browser") throw new Error("Expected continuation");
        const attempt = new URL(connection.continuation.url).searchParams.get("attempt");
        expect(
          (yield* Effect.tryPromise(() =>
            send(db, request(index, "/web/connections/begin", "POST", { attempt }))
          )).status
        ).toBe(200);
      }
      const scope = { userId: users[0], reference: "12670000-0000-4000-8000-000000000001" };
      const snapshot = (): Promise<D1Result> =>
        db.prepare("SELECT b.* FROM connection_authorizations b ORDER BY attempt_id").all();
      const before = (yield* Effect.tryPromise(snapshot)).results;
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES(?,?,1,'Draining')"
            )
            .bind(scope.reference, scope.userId),
          db
            .prepare(
              "INSERT INTO erasure_steps(request_id,store_id) VALUES(?,'connection_authorizations')"
            )
            .bind(scope.reference),
          db
            .prepare("UPDATE erasure_requests SET state='Erasing' WHERE id=?")
            .bind(scope.reference),
        ])
      );
      const store = makeConnectionsErasureStores(db).find(
        (value) => value.id === "connection_authorizations"
      );
      if (store === undefined) throw new Error("Missing authorization disposition");
      expect((yield* Effect.result(store.remove({ ...scope, userId: users[1] })))._tag).toBe(
        "Failure"
      );
      expect((yield* Effect.tryPromise(snapshot)).results).toEqual(before);
      yield* Effect.tryPromise(() =>
        expect(
          db
            .prepare(
              "UPDATE connection_authorizations SET phase='failed',verifier=NULL,handoff_url=NULL WHERE attempt_id IN(SELECT a.id FROM connection_attempts a JOIN connections c ON c.id=a.connection_id WHERE c.user_id=?)"
            )
            .bind(users[0])
            .run()
        ).rejects.toThrow("erasure_fenced")
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "CREATE TRIGGER refuse_authorization_erasure BEFORE DELETE ON connection_authorizations BEGIN SELECT RAISE(ABORT,'synthetic_erasure_failure'); END"
          )
          .run()
      );
      expect((yield* Effect.result(store.remove(scope)))._tag).toBe("Failure");
      expect((yield* Effect.tryPromise(snapshot)).results).toEqual(before);
      expect(
        (yield* Effect.tryPromise(() => db.prepare("SELECT * FROM erasure_permits").all())).results
      ).toEqual([]);
      yield* Effect.tryPromise(() => db.prepare("DROP TRIGGER refuse_authorization_erasure").run());
      expect(yield* store.remove(scope)).toBe(true);
      const retained = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ user_id: Schema.String, verifier: Schema.String }))
      )(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT c.user_id,b.verifier FROM connection_authorizations b JOIN connection_attempts a ON a.id=b.attempt_id JOIN connections c ON c.id=a.connection_id"
            )
            .all()
        )).results
      );
      expect(retained).toHaveLength(1);
      expect(retained[0]?.user_id).toBe(users[1]);
      expect(retained[0]?.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    })
  ));

it("recovers a failed activation's encrypted grant and destroys tokens only after verified cleanup", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const { bank, callback } = yield* prepareActivation(db);
      bank.scenario("malformed");
      yield* Effect.tryPromise(() => callback());
      const key = yield* ConnectionGrantKey;
      yield* sweepConnectionGrants({ db, key, bank: Option.some(bank.cleanup) });
      const rows = yield* Effect.tryPromise(() =>
        db.prepare("SELECT state,envelope FROM connection_grants").all()
      );
      expect(rows.results).toEqual([{ state: "cleanup_required", envelope: null }]);
      yield* sweepConnectionGrants({ db, key, bank: Option.some(bank.cleanup) });
      expect(bank.exchanges()).toBe(1);
    }).pipe(Effect.provideService(ConnectionGrantKey, Option.some(Redacted.make("A".repeat(43)))))
  ));

it("retains failed cleanup for a bounded retry and does not repeat a completed revocation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const { bank, callback } = yield* prepareActivation(db);
      bank.scenario("malformed");
      yield* Effect.tryPromise(() => callback());
      const sweep = sweepConnectionGrants({
        db,
        key: Option.some(Redacted.make("A".repeat(43))),
        bank: Option.some(bank.cleanup),
      });
      bank.cleanupRejected(true);
      expect(Option.isNone(yield* sweep.pipe(Effect.option))).toBe(true);
      const before = yield* Effect.tryPromise(() =>
        db.prepare("SELECT envelope,cleaned_at_ms FROM connection_grants").first()
      );
      expect(before?.envelope).toMatch(/^v1\./u);
      expect(before?.cleaned_at_ms).toBeNull();
      bank.cleanupRejected(false);
      yield* sweep;
      expect(bank.revocations()).toEqual([]);
      vi.setSystemTime(DateTime.nowUnsafe().epochMilliseconds + 300001);
      yield* sweep;
      expect(bank.revocations()).toEqual(["synthetic-refresh", "synthetic-access"]);
      yield* sweep;
      expect(bank.revocations()).toHaveLength(2);
    })
  ));
it("refuses a foreign encryption key before bank egress and preserves pending evidence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const { bank, callback } = yield* prepareActivation(db);
      bank.scenario("malformed");
      yield* Effect.tryPromise(() => callback());
      const outcome = yield* sweepConnectionGrants({
        db,
        key: Option.some(Redacted.make(Base64Url.encode(new Uint8Array(32).fill(1)))),
        bank: Option.some(bank.cleanup),
      }).pipe(Effect.option);
      expect(Option.isNone(outcome)).toBe(true);
      expect(bank.revocations()).toEqual([]);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT cleaned_at_ms FROM connection_grants").first()
        )
      ).toEqual({ cleaned_at_ms: null });
    })
  ));
it("never revokes an active customer grant during maintenance", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const { bank, callback } = yield* prepareActivation(db);
      yield* Effect.tryPromise(() => callback());
      yield* sweepConnectionGrants({
        db,
        key: Option.some(Redacted.make("A".repeat(43))),
        bank: Option.some(bank.cleanup),
      });
      expect(bank.revocations()).toEqual([]);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT state,cleaned_at_ms FROM connection_grants").first()
        )
      ).toEqual({ state: "active", cleaned_at_ms: null });
    })
  ));

it("leases cleanup once across concurrent recovery and prevents another User's active grant from being revoked", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* setup();
        const other = yield* prepareActivation(db, 1);
        other.bank.tokenLabel("other-");
        yield* Effect.tryPromise(() => other.callback());
        const own = yield* prepareActivation(db);
        own.bank.scenario("malformed");
        own.bank.tokenLabel("own-");
        yield* Effect.tryPromise(() => own.callback());
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        own.bank.beforeCleanup(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
        );
        const sweep = sweepConnectionGrants({
          db,
          key: Option.some(Redacted.make("A".repeat(43))),
          bank: Option.some(own.bank.cleanup),
        });
        const pending = yield* Effect.forkScoped(sweep);
        yield* Deferred.await(entered);
        yield* sweep;
        expect(own.bank.revocations()).toEqual([]);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(pending);
        expect(own.bank.revocations()).toEqual(["own-synthetic-refresh", "own-synthetic-access"]);
        expect(other.bank.revocations()).toEqual([]);
        const listed = yield* Effect.tryPromise(() => send(db, request(1, "/connections")));
        expect(yield* Effect.tryPromise(() => listed.json())).toMatchObject({
          data: [{ id: other.started.connection.id, state: "Active" }],
        });
      })
    )
  ));

it("retains known tokens for cleanup even when the exchange omits the required signed identity", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const { bank, callback } = yield* prepareActivation(db);
      bank.scenario("missing-identity");
      yield* Effect.tryPromise(() => callback());
      yield* sweepConnectionGrants({
        db,
        key: Option.some(Redacted.make("A".repeat(43))),
        bank: Option.some(bank.cleanup),
      });
      expect(bank.revocations()).toEqual(["synthetic-refresh", "synthetic-access"]);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT state,envelope FROM connection_grants").first()
        )
      ).toEqual({ state: "cleanup_required", envelope: null });
    })
  ));

it.each(["missing-access", "invalid-access"] as const)(
  "retains a received refresh token when the exchange has %s",
  (scenario) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const { bank, callback } = yield* prepareActivation(db);
        bank.scenario(scenario);
        yield* Effect.tryPromise(() => callback());
        yield* sweepConnectionGrants({
          db,
          key: Option.some(Redacted.make("A".repeat(43))),
          bank: Option.some(bank.cleanup),
        });
        expect(bank.revocations()).toEqual(["synthetic-refresh"]);
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT state,envelope FROM connection_grants").first()
          )
        ).toEqual({ state: "cleanup_required", envelope: null });
      })
    )
);

it("cleans only the failed generation after the same User establishes a new active grant", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const old = yield* prepareActivation(db);
      old.bank.tokenLabel("old-");
      old.bank.scenario("malformed");
      yield* Effect.tryPromise(() => old.callback());
      const current = yield* prepareActivation(db);
      current.bank.tokenLabel("new-");
      yield* Effect.tryPromise(() => current.callback());
      yield* sweepConnectionGrants({
        db,
        key: Option.some(Redacted.make("A".repeat(43))),
        bank: Option.some(old.bank.cleanup),
      });
      expect(old.bank.revocations()).toEqual(["old-synthetic-refresh", "old-synthetic-access"]);
      expect(current.bank.revocations()).toEqual([]);
      const listed = yield* Effect.tryPromise(() => send(db, request(0, "/connections")));
      expect(yield* Effect.tryPromise(() => listed.json())).toMatchObject({
        data: [{ id: old.started.connection.id, state: "Active" }],
      });
      const accounts = yield* Effect.tryPromise(() =>
        send(db, request(0, `/connections/${old.started.connection.id}/accounts`))
      );
      expect(yield* Effect.tryPromise(() => accounts.json())).toMatchObject({
        data: [
          { connectionId: old.started.connection.id },
          { connectionId: old.started.connection.id },
        ],
      });
    })
  ));
it("recovers interrupted cleanup without losing encrypted authority or replaying the authorization code", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* setup();
        const { bank, callback } = yield* prepareActivation(db);
        bank.scenario("malformed");
        yield* Effect.tryPromise(() => callback());
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        bank.beforeCleanup(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
        );
        const sweep = sweepConnectionGrants({
          db,
          key: Option.some(Redacted.make("A".repeat(43))),
          bank: Option.some(bank.cleanup),
        });
        const pending = yield* Effect.forkScoped(sweep);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(pending);
        expect(bank.revocations()).toEqual([]);
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT cleaned_at_ms FROM connection_grants").first()
          )
        ).toEqual({ cleaned_at_ms: null });
        vi.setSystemTime(DateTime.nowUnsafe().epochMilliseconds + 300001);
        bank.beforeCleanup(Effect.void);
        yield* sweep;
        expect(bank.revocations()).toEqual(["synthetic-refresh", "synthetic-access"]);
        expect(bank.exchanges()).toBe(1);
      })
    )
  ));
it("does not mark an unknown exchange with no held tokens as cleaned", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const { bank, callback } = yield* prepareActivation(db);
      bank.scenario("uncertain");
      yield* Effect.tryPromise(() => callback());
      yield* sweepConnectionGrants({
        db,
        key: Option.some(Redacted.make("A".repeat(43))),
        bank: Option.some(bank.cleanup),
      });
      expect(bank.revocations()).toEqual([]);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT state,envelope,cleaned_at_ms FROM connection_grants").first()
        )
      ).toEqual({ state: "cleanup_required", envelope: null, cleaned_at_ms: null });
      expect(bank.exchanges()).toBe(1);
    })
  ));

it("refuses destroying a retained grant or declaring cleanup before its lease is claimed", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const { bank, callback } = yield* prepareActivation(db);
      bank.scenario("malformed");
      yield* Effect.tryPromise(() => callback());
      const before = yield* Effect.tryPromise(() =>
        db.prepare("SELECT envelope FROM connection_grants").first()
      );
      const result = yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE connection_grants SET envelope=NULL,expires_at_ms=NULL,cleaned_at_ms=?")
          .bind(DateTime.nowUnsafe().epochMilliseconds)
          .run()
      ).pipe(Effect.option);
      expect(Option.isNone(result)).toBe(true);
      expect(
        yield* Effect.tryPromise(() => db.prepare("SELECT envelope FROM connection_grants").first())
      ).toEqual(before);
      expect(bank.revocations()).toEqual([]);
    })
  ));

it("attempts immediate bank cleanup if encrypted credential retention fails", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const bank = yield* activationFixture;
      const result = yield* bank.activation
        .activate({
          userId: UserId.make(users[0]),
          code: Redacted.make("synthetic-code"),
          verifier: Redacted.make("v".repeat(43)),
          consentId: "synthetic-consent",
          state: "s".repeat(43),
          intent: fixtureConsentIntent(),
          expiresAtMilliseconds: DateTime.nowUnsafe().epochMilliseconds + 60000,
          retainGrant: () => Effect.fail(new ConnectionAuthorizationUnavailable()),
        })
        .pipe(Effect.option);
      expect(Option.isNone(result)).toBe(true);
      expect(bank.revocations()).toEqual(["synthetic-refresh", "synthetic-access"]);
    })
  ));
