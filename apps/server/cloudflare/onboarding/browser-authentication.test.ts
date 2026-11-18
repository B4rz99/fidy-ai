import { handleWebAuthentication } from "../web-authentication/operations";
import { openAiTestKey } from "../openai.test-fixture";
import { registeredConnectionInstitutionIds } from "../../src/shell/connections/contract";
import { fixtureNativeHttpClient } from "../core-worker.test-fixture";
import { HttpClient } from "effect/http";
import { newId } from "../secret-material/operations";
import { UserId } from "../../src/core/identity/contract";
import { runBrowserPairingEmailWorkflow } from "../email-authentication/runtime";
import { EmailAddress, EmailVerificationCode } from "../../src/core/email-authentication/contract";
import { startBrowserPairingEmail } from "../email-authentication/operations";
import { observeOperationalHealth } from "../runtime/operational-health/operations";
import {
  installAuditTestSchema,
  installTestSchema,
  isolatedTestDatabases,
} from "../d1-test-fixture";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { approveBrowserPairing, startBrowserPairing } from "../browser-login/operations";
import { Cause, Clock, Effect, Exit, Option, Schema } from "effect";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import coreWorker, { makeCoreWorker } from "../core-worker";
import {
  DisabledTelemetryResource,
  makeTelemetryService,
} from "../../src/shell/observability/operations";
import {
  handleSupportRecovery,
  issueInitialBackupRecoveryCode,
  nativeSupportRecovery,
  retainedRecoveryPairingsQuery,
} from "../recovery/operations";
import publicWorker from "../public-worker";
import { approvedOpenAiModel } from "../../src/shell/hosted-inference/contract";

const encodeJson = (value: unknown): string =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value);

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const exchange = "10000000-0000-4000-8000-000000000001";
const setup = (
  email = "person@example.test",
  bsuid = "CO.Person1",
  {
    worker,
    database,
    accessIssuer,
    publication,
  }: {
    worker: typeof coreWorker;
    database: (db: D1Database) => D1Database;
    accessIssuer: string;
    publication: Option.Option<{ queue: Queue; context: Pick<ExecutionContext, "waitUntil"> }>;
  } = {
    worker: coreWorker,
    database: (db: D1Database): D1Database => db,
    accessIssuer: "https://example.cloudflareaccess.com",
    publication: Option.none(),
  }
): Promise<{
  db: D1Database;
  seedUser: () => Promise<Response>;
  sendRequest: (request: Request) => Promise<Response>;
}> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() => installTestSchema({ db }));

      yield* Effect.tryPromise(() => installAuditTestSchema(db));

      const now = yield* Clock.currentTimeMillis;
      yield* Effect.tryPromise(() =>
        db
          .prepare(`INSERT INTO pending_consent_exchanges
    (id,portfolio_id,bsuid,phone_number_id,initiating_message_id,initiating_body_sha256,
     correlation_token,disclosure_json,disclosure_message_id,created_at_ms,disclosed_at_ms,
     decision_not_before_ms,expires_at_ms,state)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'accepted')`)
          .bind(
            exchange,
            "portfolio",
            bsuid,
            "phone",
            "initial",
            "a".repeat(64),
            "10000000-0000-4000-8000-000000000003",
            "{}",
            "disclosure",
            now - 100000,
            now - 90000,
            now - 80000,
            now - 100000 + 86400000
          )
          .run()
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE pending_consent_exchanges SET state = 'awaiting_decision' WHERE id = ?")
          .bind(exchange)
          .run()
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            `UPDATE pending_consent_exchanges SET decision_value=incoming.decision,decision_message_id=incoming.decision_message_id,decision_delivery_key=incoming.delivery_key,decision_body_sha256=incoming.body_sha256,decision_occurred_at_ms=incoming.occurred_at_ms,decision_received_at_ms=incoming.received_at_ms FROM (SELECT ? AS exchange_id,? AS portfolio_id,? AS bsuid,? AS phone_number_id,? AS decision,? AS disclosure_json,? AS disclosure_message_id,? AS decision_message_id,? AS delivery_key,? AS body_sha256,? AS occurred_at_ms,? AS received_at_ms) AS incoming WHERE pending_consent_exchanges.id=incoming.exchange_id AND pending_consent_exchanges.decision_value IS NULL AND pending_consent_exchanges.portfolio_id IS incoming.portfolio_id AND pending_consent_exchanges.bsuid IS incoming.bsuid AND pending_consent_exchanges.phone_number_id IS incoming.phone_number_id AND pending_consent_exchanges.disclosure_json IS incoming.disclosure_json AND pending_consent_exchanges.disclosure_message_id IS incoming.disclosure_message_id`
          )
          .bind(
            exchange,
            "portfolio",
            bsuid,
            "phone",
            "accepted",
            "{}",
            "disclosure",
            "decision",
            "delivery",
            "b".repeat(64),
            now - 71000,
            now - 70000
          )
          .run()
      );
      const sendRequest = (request: Request): Promise<Response> =>
        publicWorker.fetch(request, {
          BROWSER_ORIGIN: "https://app.fidyapp.com",
          LOCAL_CANONICAL_READ_BEARER: "",
          PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
          RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
          CORE: {
            fetch: (request) =>
              worker.fetch(
                new Request(request),
                {
                  ...(Option.isSome(publication)
                    ? { BROWSER_PAIRING_EMAIL_QUEUE: publication.value.queue }
                    : {}),
                  DB: database(db),
                  OPENAI_API_KEY: openAiTestKey({ run: () => Promise.reject(new Error("unused")) }),
                  CONTRACT_DIGEST: "a".repeat(64),
                  RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
                  HOSTED_AI_MODEL: approvedOpenAiModel,
                  BROWSER_ORIGIN: "https://app.fidyapp.com",
                  WOMPI_ENVIRONMENT: "",
                  WOMPI_PUBLIC_KEY: "",
                  WOMPI_PRIVATE_KEY: "",
                  WOMPI_INTEGRITY_SECRET: "",
                  USER_TRANSACTION_COORDINATOR: {
                    getByName: () => ({ fetch: () => Promise.reject(new Error("unused")) }),
                  },
                  KAPSO_API_KEY: "",
                  WHATSAPP_SANDBOX_PHONE_NUMBER_ID: "",
                  KAPSO_WEBHOOK_SECRET: "onboarding-test-secret",
                  CLOUDFLARE_ACCESS_ISSUER: accessIssuer,
                  CLOUDFLARE_ACCESS_AUDIENCE: "test-support-audience",
                  WHATSAPP_BUSINESS_PORTFOLIO_ID: "portfolio",
                },
                Option.isSome(publication) ? publication.value.context : undefined
              ),
          },
        });
      const seedUser = (): Promise<Response> => {
        const userId = UserId.make(newId());
        return issueInitialBackupRecoveryCode({
          db,
          userId,
          createdAtMs: now,
          commit: (credential) =>
            db
              .batch([
                db
                  .prepare(
                    "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)"
                  )
                  .bind(userId, now),
                db
                  .prepare(
                    "WITH incoming(user_id,portfolio_id,bsuid,verified_at_ms) AS (VALUES (?, 'portfolio', ?, ?)) INSERT INTO users(id,service_market,locale,time_zone,created_at_ms,whatsapp_portfolio_id,whatsapp_bsuid,whatsapp_verified_at_ms) SELECT incoming.user_id,'CO','es-CO','America/Bogota',0,incoming.portfolio_id,incoming.bsuid,incoming.verified_at_ms FROM incoming WHERE true ON CONFLICT(id) DO UPDATE SET whatsapp_portfolio_id=excluded.whatsapp_portfolio_id,whatsapp_bsuid=excluded.whatsapp_bsuid,whatsapp_verified_at_ms=excluded.whatsapp_verified_at_ms"
                  )
                  .bind(userId, bsuid, now),
                db
                  .prepare(
                    "WITH incoming(user_id,email_address,verified_at_ms) AS (VALUES (?, ?, ?)) INSERT INTO verified_email_credentials(user_id,address,verified_at_ms) SELECT incoming.user_id,incoming.email_address,incoming.verified_at_ms FROM incoming WHERE true ON CONFLICT(user_id) DO UPDATE SET address=excluded.address,verified_at_ms=excluded.verified_at_ms"
                  )
                  .bind(userId, email, now),
                db
                  .prepare(
                    "INSERT INTO consent_history (record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms) VALUES ('processing_grant',?, ?, '{}', 'disclosure', 'decision', ?, ?)"
                  )
                  .bind(exchange, userId, now, now),
                db
                  .prepare(
                    "UPDATE users SET trial_started_at_ms=?2,trial_ends_at_ms=?3 WHERE id=?1"
                  )
                  .bind(userId, now, now + 604800000),
                credential,
              ])
              .then(() => undefined),
        }).then((backupRecoveryCode) => Response.json({ backupRecoveryCode }));
      };
      return { db, seedUser, sendRequest };
    })
  );

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("rejects unproved support recovery without creating a case or approving a pairing", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, seedUser, sendRequest } = yield* Effect.tryPromise(() => setup());
      expect((yield* Effect.tryPromise(() => seedUser())).status).toBe(200);
      const pairing: { pairingId: string; publicCode: string } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ pairingId: Schema.String, publicCode: Schema.String })
      )(
        yield* startBrowserPairing({ db, retainedPairings: retainedRecoveryPairingsQuery() }).pipe(
          Effect.flatMap((response) => Effect.tryPromise(() => response.json()))
        )
      );
      const response = yield* Effect.tryPromise(() =>
        sendRequest(
          new Request("https://api.fidyapp.com/internal/support-recovery", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: encodeJson({
              pairingCode: pairing.publicCode,
              backupRecoveryCode: "AAAAA-AAAAA-AAAAA-AAAAA-AAAAA",
            }),
          })
        )
      );
      expect(response.status).toBe(401);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM support_recovery_cases")
            .first<{ count: number }>()
        ))?.count
      ).toBe(0);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT state FROM browser_login_pairings WHERE id = ?")
            .bind(pairing.pairingId)
            .first()
        )
      ).toMatchObject({ state: "pending_approval" });
    })
  ));

it("keeps unexpected recovery defects out of operational failures and observes one closed route outcome", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const failures: Array<unknown> = [];
      const telemetry = makeTelemetryService({
        ...DisabledTelemetryResource.adapter,
        captureFailure: (_span, failure) =>
          Effect.sync(() => {
            failures.push(failure);
          }),
      });
      let failure: "defect" | "d1" | "none" = "none";
      const database = (db: D1Database): D1Database =>
        new Proxy(db, {
          get(target, property, receiver) {
            if (property === "prepare" && failure !== "none") {
              const kind = failure;
              failure = "none";
              return () => {
                throw new Error(
                  kind === "defect" ? "programmer defect: secret pairing and SQL text" : "D1_ERROR"
                );
              };
            }
            const value: unknown = Reflect.get(target, property, receiver);
            return value;
          },
        });
      const { db, seedUser } = yield* Effect.tryPromise(() =>
        setup("person@example.test", "CO.Person1", {
          worker: makeCoreWorker({ telemetry, institutions: registeredConnectionInstitutionIds }),
          database,
          publication: Option.none(),
          accessIssuer: "https://defect.cloudflareaccess.com",
        })
      );
      const created: { backupRecoveryCode: string } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ backupRecoveryCode: Schema.String })
      )(yield* Effect.tryPromise(() => seedUser().then((result) => result.json())));
      const pairing: { publicCode: string } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ publicCode: Schema.String })
      )(
        yield* startBrowserPairing({ db, retainedPairings: retainedRecoveryPairingsQuery() }).pipe(
          Effect.flatMap((response) => Effect.tryPromise(() => response.json()))
        )
      );
      const { publicKey, privateKey } = yield* Effect.tryPromise(() => generateKeyPair("RS256"));
      const jwk = {
        ...(yield* Effect.tryPromise(() => exportJWK(publicKey))),
        kid: "defect-key",
        alg: "RS256",
        use: "sig",
      };
      vi.spyOn(globalThis, "fetch").mockImplementation(() =>
        Promise.resolve(Response.json({ keys: [jwk] }))
      );
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const assertion = yield* Effect.tryPromise(() =>
        new SignJWT({})
          .setProtectedHeader({ alg: "RS256", kid: "defect-key" })
          .setIssuer("https://defect.cloudflareaccess.com")
          .setAudience("test-support-audience")
          .setSubject("test-operator")
          .setIssuedAt(now)
          .setExpirationTime(now + 300)
          .sign(privateKey)
      );
      const request = (): Request =>
        new Request("https://api.fidyapp.com/internal/support-recovery", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "cf-access-jwt-assertion": assertion,
          },
          body: encodeJson({
            pairingCode: pairing.publicCode,
            backupRecoveryCode: created.backupRecoveryCode,
          }),
        });
      const config = {
        CLOUDFLARE_ACCESS_ISSUER: "https://defect.cloudflareaccess.com",
        CLOUDFLARE_ACCESS_AUDIENCE: "test-support-audience",
      };
      failure = "defect";
      const exit = yield* Effect.exit(
        handleSupportRecovery({ request: request(), db: database(db), config }).pipe(
          Effect.provideService(HttpClient.HttpClient, yield* fixtureNativeHttpClient)
        )
      );
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
      const sendSupport = (
        broken: boolean
      ): Effect.Effect<Response, never, HttpClient.HttpClient> =>
        handleWebAuthentication({
          loginEmail: Effect.die("Unexpected login email"),
          request: request(),
          db,

          telemetry,
          publish: () => {},
          support: nativeSupportRecovery({
            request: request(),
            config,
            directory: Option.some({
              getByName: () => ({
                fetch: () =>
                  broken
                    ? Promise.reject(new Error("unexpected adapter defect"))
                    : Promise.resolve(new Response(null, { status: 503 })),
              }),
            }),
          }),
        });
      const http = yield* fixtureNativeHttpClient;
      const returned = yield* sendSupport(true).pipe(
        Effect.provideService(HttpClient.HttpClient, http)
      );
      expect(returned.status).toBe(503);
      expect(yield* Effect.tryPromise(() => returned.json())).toEqual({ status: "unavailable" });
      expect(failures).toEqual([
        {
          _tag: "Defect",
          component: "api",
          operation: "http.supportRecovery",
          error: "unexpected_defect",
          cause: undefined,
        },
      ]);
      expect(
        (yield* sendSupport(false).pipe(Effect.provideService(HttpClient.HttpClient, http))).status
      ).toBe(503);
      expect(failures).toHaveLength(1);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM support_recovery_cases")
            .first<{ count: number }>()
        ))?.count
      ).toBe(0);
    }).pipe(Effect.scoped)
  ));

it("does not impose a shared login lockout after concurrent pairing starts", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Effect.tryPromise(() => setup());
      const starts = yield* Effect.all(
        Array.from({ length: 101 }, () =>
          startBrowserPairing({ db, retainedPairings: retainedRecoveryPairingsQuery() })
        ),
        { concurrency: 101 }
      );
      expect(starts.every((response) => response.status === 200)).toBe(true);
      expect(
        (yield* startBrowserPairing({ db, retainedPairings: retainedRecoveryPairingsQuery() }))
          .status
      ).toBe(200);
    })
  ));

it(
  "reports rejected delivery even when its Workflow completed successfully",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db, seedUser } = yield* Effect.tryPromise(() => setup());
        yield* Effect.tryPromise(() => seedUser());
        const pairing = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ pairingId: Schema.String, privateVerifier: Schema.String })
        )(
          yield* startBrowserPairing({
            db,
            retainedPairings: retainedRecoveryPairingsQuery(),
          }).pipe(Effect.flatMap((response) => Effect.tryPromise(() => response.json())))
        );
        const accepted = yield* Effect.tryPromise(() =>
          startBrowserPairingEmail({
            db,
            onAccepted: () => undefined,
            request: new Request("https://api.fidyapp.com/web/email/authentication/start", {
              method: "POST",
              headers: { origin: "https://app.fidyapp.com", "content-type": "application/json" },
              body: encodeJson({ ...pairing, email: "person@example.test" }),
            }),
          })
        );
        expect(accepted.status).toBe(202);
        const work = yield* Schema.decodeUnknownEffect(Schema.Struct({ work_id: Schema.String }))(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT work_id FROM (SELECT rowid,id AS pairing_id,email_work_id AS work_id,email_user_id AS user_id,email_address,email_credential_verified_at_ms AS credential_verified_at_ms,email_state AS state,email_public_code AS public_code,email_proof_digest AS proof_digest,email_proof_expires_at_ms AS proof_expires_at_ms,email_expires_at_ms AS expires_at_ms,email_generation AS generation,email_wrong_attempts AS wrong_attempts,email_last_requested_at_ms AS last_requested_at_ms,email_dispatch_attempted_at_ms AS dispatch_attempted_at_ms FROM browser_login_pairings WHERE email_work_id IS NOT NULL) AS browser_pairing_email_proofs"
              )
              .first()
          )
        );
        yield* Effect.tryPromise(() =>
          deliverBrowserPairingEmail({ db, send: () => Promise.resolve("rejected") })(work.work_id)
        );
        const signals = yield* observeOperationalHealth({
          DB: db,
          proactivity: { weeklyEnabled: false, proactivityEnabled: false },
          workflows: {
            browserPairing: {
              get: () => Promise.resolve({ status: () => Promise.resolve({ status: "complete" }) }),
            },
          },
          deadLetters: Option.some({
            metrics: () => Promise.resolve({ backlogCount: 0, backlogBytes: 0 }),
          }),
          workQueues: {},
        });
        expect(signals.find((signal) => signal.operation === "browserPairing")).toMatchObject({
          state: "attention",
          sampledPending: 0,
          sampledRejectedEmailWork: 1,
          failedWorkflows: 0,
        });
      })
    ),
  30_000
);

const deliverBrowserPairingEmail =
  (input: {
    db: D1Database;
    send: (
      to: EmailAddress,
      code: EmailVerificationCode,
      id: string
    ) => Promise<"succeeded" | "rejected" | "ambiguous">;
  }) =>
  (id: string): Promise<void> => {
    const provider = vi.spyOn(globalThis, "fetch").mockImplementation((request, init) =>
      new Request(request, init)
        .json()
        .then((body) => {
          const email = Schema.decodeUnknownSync(
            Schema.Struct({ to: Schema.Array(EmailAddress), text: Schema.String })
          )(body);
          const code = Schema.decodeUnknownSync(EmailVerificationCode)(
            /[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}(?:-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}){5}/u.exec(
              email.text
            )?.[0]
          );
          return input.send(EmailAddress.make(email.to[0] ?? "missing@example.test"), code, id);
        })
        .then((result) =>
          result === "succeeded"
            ? Response.json({ id: "synthetic-message" })
            : Response.json(
                { error: "synthetic-refusal" },
                { status: result === "rejected" ? 400 : 503 }
              )
        )
    );
    return runBrowserPairingEmailWorkflow({
      environment: { DB: input.db, RESEND_API_KEY: "synthetic-test-provider-key" },
      payload: { kind: "browser-pairing-email", version: 1, id },
      activity: (_name, _options, activity) => activity(),
    }).finally(() => provider.mockRestore());
  };
it("approves a pending pairing through its verified WhatsApp owner", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, seedUser } = yield* Effect.tryPromise(() => setup());
      expect((yield* Effect.tryPromise(() => seedUser())).status).toBe(200);
      const pairing = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ publicCode: Schema.String })
      )(
        yield* startBrowserPairing({ db, retainedPairings: retainedRecoveryPairingsQuery() }).pipe(
          Effect.flatMap((response) => Effect.tryPromise(() => response.json()))
        )
      );
      const now = yield* Clock.currentTimeMillis;
      const response = yield* approveBrowserPairing({
        db,
        input: {
          portfolioId: "portfolio",
          bsuid: "CO.Person1",
          messageId: "native-performance-approval",
          publicCode: pairing.publicCode,
          occurredAtMs: now,
          receivedAtMs: now,
        },
      });
      expect(response.status).toBe(200);
    })
  ));
