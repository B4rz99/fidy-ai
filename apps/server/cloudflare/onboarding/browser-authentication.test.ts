import { newId } from "../secret-material/operations";
import { UserId } from "../../src/core/identity/contract";
import {
  dispatchBrowserPairingEmail,
  dispatchEmailReplacement,
  runBrowserPairingEmailWorkflow,
  runEmailReplacementWorkflow,
} from "../email-authentication/runtime";
import { EmailAddress, EmailVerificationCode } from "../../src/core/email-authentication/contract";
import { observeOperationalHealth } from "../runtime/operational-health/operations";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { startBrowserPairing } from "../browser-login/operations";

import { Cause, Clock, Effect, Exit, Option, Schema } from "effect";

import { SignJWT, exportJWK, generateKeyPair } from "jose";
import coreWorker, { makeCoreWorker } from "../core-worker";
import {
  DisabledTelemetryResource,
  makeTelemetryService,
} from "../../src/shell/observability/operations";

import { handleSupportRecovery, issueInitialBackupRecoveryCode } from "../recovery/operations";
import publicWorker from "../public-worker";
import { approvedWorkersAiModel } from "../../src/shell/hosted-inference/contract";

const encodeJson = (value: unknown): string =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value);

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const exchange = "10000000-0000-4000-8000-000000000001";
const digest = (text: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(text))
    .then((bytes) => new Uint8Array(bytes));

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
      yield* Effect.tryPromise(() =>
        installTestSchema({
          db,
          sources: [
            "0003_pending_consent",
            "0005_verified_onboarding",
            "0006_browser_login",
            "0007_browser_pairing_email",
            "0008_support_recovery",
            "0009_email_replacement",
          ].map((name) => new URL(`../migrations/${name}.sql`, import.meta.url)),
        })
      );

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
      // Enter the decision phase before recording the append-only accepted evidence.
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE pending_consent_exchanges SET state = 'awaiting_decision' WHERE id = ?")
          .bind(exchange)
          .run()
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare(`INSERT INTO pending_consent_decisions
    (exchange_id,portfolio_id,bsuid,phone_number_id,decision,disclosure_json,disclosure_message_id,
     decision_message_id,delivery_key,body_sha256,occurred_at_ms,received_at_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
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
                  AI: { run: () => Promise.reject(new Error("unused")) },
                  CONTRACT_DIGEST: "a".repeat(64),
                  RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
                  HOSTED_AI_MODEL: approvedWorkersAiModel,
                  BROWSER_ORIGIN: "https://app.fidyapp.com",
                  WOMPI_ENVIRONMENT: "",
                  WOMPI_PUBLIC_KEY: "",
                  WOMPI_PRIVATE_KEY: "",
                  WOMPI_INTEGRITY_SECRET: "",
                  USER_TRANSACTION_COORDINATOR: {
                    getByName: () => ({ fetch: () => Promise.reject(new Error("unused")) }),
                  },
                  KAPSO_API_KEY: "",
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
                  .prepare("INSERT INTO users VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)")
                  .bind(userId, now),
                db
                  .prepare("INSERT INTO whatsapp_identities VALUES (?, 'portfolio', ?, ?)")
                  .bind(userId, bsuid, now),
                db
                  .prepare("INSERT INTO verified_email_credentials VALUES (?, ?, ?)")
                  .bind(userId, email, now),
                db
                  .prepare(
                    "INSERT INTO onboarding_consent_records VALUES (?, ?, '{}', 'disclosure', 'decision', ?, ?)"
                  )
                  .bind(exchange, userId, now, now),
                db
                  .prepare("INSERT INTO trial_periods VALUES (?, ?, ?)")
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

const seedWebSession = (db: D1Database, token: string): Promise<number> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const pairing: { pairingId: string } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ pairingId: Schema.String })
      )(
        yield* startBrowserPairing(db).pipe(
          Effect.flatMap((response) => Effect.tryPromise(() => response.json()))
        )
      );

      const started = yield* Clock.currentTimeMillis;
      yield* Effect.tryPromise(() =>
        db
          .prepare(`UPDATE browser_login_pairings SET state = 'ready',
      user_id = (SELECT id FROM users) WHERE id = ?`)
          .bind(pairing.pairingId)
          .run()
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE browser_login_pairings SET state = 'consumed' WHERE id = ?")
          .bind(pairing.pairingId)
          .run()
      );
      yield* Effect.tryPromise(() =>
        digest(token).then((awaited0) =>
          db
            .prepare(`INSERT INTO web_sessions
      (id, pairing_id, user_id, token_digest, created_at_ms, fresh_until_ms,
       idle_expires_at_ms, hard_expires_at_ms)
       VALUES (?, ?, (SELECT id FROM users), ?, ?, ?, ?, ?) `)
            .bind(
              "10000000-0000-4000-8000-000000000099",
              pairing.pairingId,
              awaited0,
              started,
              started + 600_000,
              started + 2_592_000_000,
              started + 7_776_000_000
            )
            .run()
        )
      );
      return started;
    })
  );

type SendWorkerRequest = (request: Request) => Promise<Response>;

const replacementRequest =
  (sendRequest: SendWorkerRequest, token: string) =>
  (
    path: string,
    body: object,
    options: { cookie: string; origin: string } = {
      cookie: token,
      origin: "https://app.fidyapp.com",
    }
  ): Promise<Response> =>
    sendRequest(
      new Request(`https://api.fidyapp.com${path}`, {
        method: "POST",
        headers: {
          origin: options.origin,
          cookie: `__Host-fidy_session=${options.cookie}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      })
    );

const deliverPendingReplacement = (db: D1Database): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      let workId = "";
      yield* dispatchEmailReplacement({
        identity: Option.none(),
        DB: db,
        EMAIL_REPLACEMENT_QUEUE: {
          send: (work) => {
            workId = work.id;
            return Promise.resolve();
          },
        },
      });
      let proof = "";
      yield* Effect.tryPromise(() =>
        deliverEmailReplacement({
          db,
          send: (_to, received) => {
            proof = received;
            return Promise.resolve("succeeded");
          },
        })(workId)
      );
      return proof;
    })
  );

it("renews an active WebSession until its hard deadline and never revives an expired one", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, seedUser, sendRequest } = yield* Effect.tryPromise(() => setup());
      expect((yield* Effect.tryPromise(() => seedUser())).status).toBe(200);
      const token = "B".repeat(43);
      const started = yield* Effect.tryPromise(() => seedWebSession(db, token));
      const use = (): Promise<Response> =>
        sendRequest(
          new Request("https://api.fidyapp.com/user", {
            headers: { origin: "https://app.fidyapp.com", cookie: `__Host-fidy_session=${token}` },
          })
        );
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(started + 29 * 86_400_000);
      const renewed = yield* Effect.tryPromise(() => use());
      expect(renewed.status).toBe(200);
      expect(renewed.headers.get("set-cookie")).toContain("Max-Age=2592000");
      vi.setSystemTime(started + 45 * 86_400_000);
      expect((yield* Effect.tryPromise(() => use())).status).toBe(200);
      vi.setSystemTime(started + 90 * 86_400_000);
      expect((yield* Effect.tryPromise(() => use())).status).toBe(401);
    })
  ));

it("refuses an idle-expired WebSession without writing a canonical User read", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, seedUser, sendRequest } = yield* Effect.tryPromise(() => setup());
      expect((yield* Effect.tryPromise(() => seedUser())).status).toBe(200);
      const token = "C".repeat(43);
      const started = yield* Effect.tryPromise(() => seedWebSession(db, token));
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(started + 29 * 86_400_000);
      const crossSite = yield* Effect.tryPromise(() =>
        sendRequest(
          new Request("https://api.fidyapp.com/user", {
            headers: { cookie: `__Host-fidy_session=${token}` },
          })
        )
      );
      expect(crossSite.status).toBe(403);
      expect(crossSite.headers.get("set-cookie")).toBeNull();
      vi.setSystemTime(started + 31 * 86_400_000);
      const result = yield* Effect.tryPromise(() =>
        sendRequest(
          new Request("https://api.fidyapp.com/user", {
            headers: { origin: "https://app.fidyapp.com", cookie: `__Host-fidy_session=${token}` },
          })
        )
      );
      expect(result.status).toBe(401);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM canonical_user_reads")
            .first<{ count: number }>()
        ))?.count
      ).toBe(0);
    })
  ));

it("refuses recovery rotation after WebSession freshness expires without changing the proof", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, seedUser, sendRequest } = yield* Effect.tryPromise(() => setup());
      expect((yield* Effect.tryPromise(() => seedUser())).status).toBe(200);
      const token = "D".repeat(43);
      const started = yield* Effect.tryPromise(() => seedWebSession(db, token));
      const before = yield* Effect.tryPromise(() =>
        db.prepare("SELECT code_digest FROM backup_recovery_credentials").first()
      );
      const rotate = (origin: string): Promise<Response> =>
        sendRequest(
          new Request("https://api.fidyapp.com/recovery/backup-code/rotate", {
            method: "POST",
            headers: { origin, cookie: `__Host-fidy_session=${token}` },
          })
        );
      expect((yield* Effect.tryPromise(() => rotate("https://attacker.example"))).status).toBe(403);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(started + 600_000);
      expect((yield* Effect.tryPromise(() => rotate("https://app.fidyapp.com"))).status).toBe(401);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT code_digest FROM backup_recovery_credentials").first()
        )
      ).toEqual(before);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM canonical_security_mutations")
            .first<{ count: number }>()
        ))?.count
      ).toBe(0);
    })
  ));

it("admits email approval only for a browser-held verifier and an existing verified mailbox", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, seedUser, sendRequest } = yield* Effect.tryPromise(() => setup());
      expect((yield* Effect.tryPromise(() => seedUser())).status).toBe(200);
      const start = yield* Effect.tryPromise(() =>
        sendRequest(
          new Request("https://api.fidyapp.com/web/pairings", {
            method: "POST",
            headers: { origin: "https://app.fidyapp.com" },
          })
        )
      );
      const pairing: { pairingId: string; privateVerifier: string } =
        yield* Schema.decodeUnknownEffect(
          Schema.Struct({ pairingId: Schema.String, privateVerifier: Schema.String })
        )(yield* Effect.tryPromise(() => start.json()));
      const begin = (privateVerifier: string, email: string): Promise<Response> =>
        sendRequest(
          new Request("https://api.fidyapp.com/web/email/authentication/start", {
            method: "POST",
            headers: { origin: "https://app.fidyapp.com", "content-type": "application/json" },
            body: encodeJson({ pairingId: pairing.pairingId, privateVerifier, email }),
          })
        );
      expect(
        (yield* Effect.tryPromise(() => begin("A".repeat(43), "person@example.test"))).status
      ).toBe(400);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM browser_pairing_email_outbox")
            .first<{ count: number }>()
        ))?.count
      ).toBe(0);
      const unknownInitiation = yield* Effect.tryPromise(() =>
        begin(pairing.privateVerifier, "unknown@example.test")
      );
      expect(unknownInitiation.status).toBe(202);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM browser_pairing_email_outbox")
            .first<{ count: number }>()
        ))?.count
      ).toBe(0);
      const knownInitiation = yield* Effect.tryPromise(() =>
        begin(pairing.privateVerifier, "person@example.test")
      );
      expect(knownInitiation.status).toBe(unknownInitiation.status);
      expect(knownInitiation.headers.get("cache-control")).toBe("no-store");
      expect(yield* Effect.tryPromise(() => knownInitiation.text())).toBe(
        yield* Effect.tryPromise(() => unknownInitiation.text())
      );
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM browser_pairing_email_outbox")
            .first<{ count: number }>()
        ))?.count
      ).toBe(1);
      let workId = "";
      yield* dispatchBrowserPairingEmail({
        identity: Option.none(),
        DB: db,
        BROWSER_PAIRING_EMAIL_QUEUE: {
          send: (work) => {
            workId = work.id;
            return Promise.resolve();
          },
        },
      });
      let receivedCode = "";
      yield* Effect.tryPromise(() =>
        deliverBrowserPairingEmail({
          db,
          send: (_email, combinedCode) => {
            receivedCode = combinedCode;
            return Promise.resolve("succeeded");
          },
        })(workId)
      );
      const complete = (combinedCode: string, privateVerifier: string): Promise<Response> =>
        sendRequest(
          new Request("https://api.fidyapp.com/web/email/authentication/complete", {
            method: "POST",
            headers: { origin: "https://app.fidyapp.com", "content-type": "application/json" },
            body: encodeJson({ pairingId: pairing.pairingId, privateVerifier, combinedCode }),
          })
        );
      expect((yield* Effect.tryPromise(() => complete(receivedCode, "A".repeat(43)))).status).toBe(
        400
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare(`UPDATE verified_email_credentials
    SET verified_at_ms = verified_at_ms + 1`)
          .run()
      );
      expect(
        (yield* Effect.tryPromise(() => complete(receivedCode, pairing.privateVerifier))).status
      ).toBe(400);
      yield* Effect.tryPromise(() =>
        db
          .prepare(`UPDATE verified_email_credentials
    SET verified_at_ms = verified_at_ms - 1`)
          .run()
      );
      expect(
        (yield* Effect.tryPromise(() => complete(receivedCode, pairing.privateVerifier))).status
      ).toBe(200);
      expect(
        (yield* Effect.tryPromise(() => complete(receivedCode, pairing.privateVerifier))).status
      ).toBe(400);
      const redeemed = yield* Effect.tryPromise(() =>
        sendRequest(
          new Request("https://api.fidyapp.com/web/pairings/redeem", {
            method: "POST",
            headers: { origin: "https://app.fidyapp.com", "content-type": "application/json" },
            body: encodeJson({
              pairingId: pairing.pairingId,
              privateVerifier: pairing.privateVerifier,
            }),
          })
        )
      );
      expect(redeemed.status).toBe(200);
      expect(redeemed.headers.get("set-cookie")).toContain("__Host-fidy_session=");
    })
  ));

it("rejects each User's email proof at the other browser pairing without consuming either proof", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, seedUser, sendRequest } = yield* Effect.tryPromise(() => setup());
      expect((yield* Effect.tryPromise(() => seedUser())).status).toBe(200);
      const otherUser = "10000000-0000-4000-8000-000000000004";
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare("INSERT INTO users VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)")
            .bind(otherUser, now),
          db
            .prepare("INSERT INTO verified_email_credentials VALUES (?, ?, ?)")
            .bind(otherUser, "other@example.test", now),
        ])
      );
      const startEmailProof = (
        email: string
      ): Effect.Effect<
        Readonly<{ pairingId: string; privateVerifier: string; combinedCode: string }>,
        Cause.UnknownError | Schema.SchemaError | void
      > =>
        Effect.gen(function* () {
          const started = yield* Effect.tryPromise(() =>
            sendRequest(
              new Request("https://api.fidyapp.com/web/pairings", {
                method: "POST",
                headers: { origin: "https://app.fidyapp.com" },
              })
            )
          );
          const pairing = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ pairingId: Schema.String, privateVerifier: Schema.String })
          )(yield* Effect.tryPromise(() => started.json()));
          const initiation = yield* Effect.tryPromise(() =>
            sendRequest(
              new Request("https://api.fidyapp.com/web/email/authentication/start", {
                method: "POST",
                headers: {
                  origin: "https://app.fidyapp.com",
                  "content-type": "application/json",
                },
                body: encodeJson({ ...pairing, email }),
              })
            )
          );
          expect(initiation.status).toBe(202);
          let workId = "";
          yield* dispatchBrowserPairingEmail({
            identity: Option.none(),
            DB: db,
            BROWSER_PAIRING_EMAIL_QUEUE: {
              send: (work) => {
                workId = work.id;
                return Promise.resolve();
              },
            },
          });
          let combinedCode = "";
          yield* Effect.tryPromise(() =>
            deliverBrowserPairingEmail({
              db,
              send: (to, receivedCode) => {
                expect(to).toBe(email);
                combinedCode = receivedCode;
                return Promise.resolve("succeeded");
              },
            })(workId)
          );
          expect(combinedCode).not.toBe("");
          return { ...pairing, combinedCode };
        });
      const first = yield* startEmailProof("person@example.test");
      const second = yield* startEmailProof("other@example.test");
      const snapshot = (): Promise<ReadonlyArray<D1Result>> =>
        db.batch([
          db.prepare("SELECT * FROM browser_login_pairings ORDER BY id"),
          db.prepare("SELECT * FROM browser_pairing_email_proofs ORDER BY pairing_id"),
        ]);
      const before = (yield* Effect.tryPromise(snapshot)).map((result) => result.results);
      const complete = (proof: typeof first): Promise<Response> =>
        sendRequest(
          new Request("https://api.fidyapp.com/web/email/authentication/complete", {
            method: "POST",
            headers: { origin: "https://app.fidyapp.com", "content-type": "application/json" },
            body: encodeJson(proof),
          })
        );
      for (const crossed of [
        { ...first, combinedCode: second.combinedCode },
        { ...second, combinedCode: first.combinedCode },
      ]) {
        const refused = yield* Effect.tryPromise(() => complete(crossed));
        expect(refused.status).toBe(400);
        expect(refused.headers.get("set-cookie")).toBeNull();
        expect((yield* Effect.tryPromise(snapshot)).map((result) => result.results)).toEqual(
          before
        );
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT count(*) AS count FROM web_sessions").first()
          )
        ).toEqual({ count: 0 });
      }
      expect((yield* Effect.tryPromise(() => complete(first))).status).toBe(200);
      expect((yield* Effect.tryPromise(() => complete(second))).status).toBe(200);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT user_id FROM browser_login_pairings WHERE id = ?")
            .bind(second.pairingId)
            .first()
        )
      ).toEqual({ user_id: otherUser });
    })
  ));

it("replaces one credential only after fresh-session candidate proof and rejects replay", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, seedUser, sendRequest } = yield* Effect.tryPromise(() => setup());
      expect((yield* Effect.tryPromise(() => seedUser())).status).toBe(200);
      const token = "E".repeat(43);
      yield* Effect.tryPromise(() => seedWebSession(db, token));
      const request = replacementRequest(sendRequest, token);
      expect(
        (yield* Effect.tryPromise(() =>
          request(
            "/email/replacement",
            { candidateEmail: "new@example.test" },
            { cookie: token, origin: "https://attacker.test" }
          )
        )).status
      ).toBe(403);
      expect(
        (yield* Effect.tryPromise(() =>
          request("/email/replacement", { candidateEmail: "  NEW@example.test " })
        )).status
      ).toBe(200);
      const proof = yield* Effect.tryPromise(() => deliverPendingReplacement(db));
      expect(
        (yield* Effect.tryPromise(() =>
          request(
            "/web/email/replacement/verify",
            { combinedCode: proof },
            { cookie: "F".repeat(43), origin: "https://app.fidyapp.com" }
          )
        )).status
      ).toBe(401);
      expect(
        (yield* Effect.tryPromise(() =>
          request("/web/email/replacement/verify", {
            combinedCode: proof.slice(0, -1) + (proof.endsWith("2") ? "3" : "2"),
          })
        )).status
      ).toBe(400);
      const redemptions = yield* Effect.tryPromise(() =>
        Promise.all([
          request("/web/email/replacement/verify", { combinedCode: proof }),
          request("/web/email/replacement/verify", { combinedCode: proof }),
        ])
      );
      expect(
        redemptions.map((response) => response.status).sort((left, right) => left - right)
      ).toEqual([200, 400]);
      expect(
        yield* Effect.tryPromise(() =>
          Promise.all(
            redemptions
              .filter((response) => response.status === 200)
              .map((response) => response.json())
          )
        )
      ).toEqual([{ data: { status: "replaced" }, next: [] }]);
      expect(
        (yield* Effect.tryPromise(() =>
          request("/web/email/replacement/verify", { combinedCode: proof })
        )).status
      ).toBe(400);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT email_address FROM verified_email_credentials").first()
        )
      ).toMatchObject({ email_address: "new@example.test" });
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM users").first<{ count: number }>()
        ))?.count
      ).toBe(1);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM email_replacement_audit")
            .first<{ count: number }>()
        ))?.count
      ).toBe(5);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT operation, outcome FROM email_replacement_audit WHERE outcome = 'replaced'"
            )
            .first()
        )
      ).toMatchObject({
        operation: "completeEmailReplacement",
        outcome: "replaced",
      });
    })
  ));

it("refuses malformed replacement work and revoked or foreign sessions before delivering a proof", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, seedUser, sendRequest } = yield* Effect.tryPromise(() => setup());
      expect((yield* Effect.tryPromise(() => seedUser())).status).toBe(200);
      const token = "K".repeat(43);
      const started = yield* Effect.tryPromise(() => seedWebSession(db, token));
      const request = replacementRequest(sendRequest, token);
      expect(
        (yield* Effect.tryPromise(() =>
          request("/email/replacement", { candidateEmail: "replacement@example.test" })
        )).status
      ).toBe(200);
      const replacement = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ work_id: Schema.String, session_id: Schema.String })
      )(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT work_id, session_id FROM email_replacements").first()
        )
      );
      const snapshot = (): Effect.Effect<ReadonlyArray<D1Result["results"]>, Cause.UnknownError> =>
        Effect.map(
          Effect.tryPromise(() =>
            db.batch([
              db.prepare("SELECT * FROM email_replacements"),
              db.prepare("SELECT * FROM email_replacement_outbox"),
              db.prepare("SELECT * FROM verified_email_credentials ORDER BY user_id"),
              db.prepare("SELECT * FROM email_replacement_audit"),
            ])
          ),
          (results) => results.map((result) => result.results)
        );
      const provider = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("unexpected send"));
      let activities = 0;
      const run = (payload: unknown): Promise<void> =>
        runEmailReplacementWorkflow({
          environment: { DB: db, RESEND_API_KEY: "synthetic-test-provider-key" },
          payload,
          activity: (_name, _options, activity) => {
            activities++;
            return activity();
          },
        });
      const work = { kind: "email-replacement", version: 1, id: replacement.work_id };
      const beforeMalformed = yield* snapshot();
      for (const payload of [
        null,
        { ...work, kind: "browser-pairing-email" },
        { ...work, version: 2 },
        { ...work, id: "invalid-work-id" },
      ]) {
        yield* Effect.tryPromise(() => run(payload));
        expect(activities).toBe(0);
        expect(provider).not.toHaveBeenCalled();
        expect(yield* snapshot()).toEqual(beforeMalformed);
      }
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE web_sessions SET revoked_at_ms = ? WHERE id = ?")
          .bind(started, replacement.session_id)
          .run()
      );
      yield* Effect.tryPromise(() => run(work));
      expect(activities).toBe(1);
      expect(provider).not.toHaveBeenCalled();
      expect(yield* snapshot()).toEqual(beforeMalformed);
      const otherUser = "10000000-0000-4000-8000-000000000004";
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare("INSERT INTO users VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)")
            .bind(otherUser, started),
          db
            .prepare("INSERT INTO verified_email_credentials VALUES (?, ?, ?)")
            .bind(otherUser, "foreign@example.test", started),
          db
            .prepare(
              "UPDATE browser_login_pairings SET user_id = ? WHERE id = (SELECT pairing_id FROM web_sessions WHERE id = ?)"
            )
            .bind(otherUser, replacement.session_id),
          db
            .prepare("UPDATE web_sessions SET revoked_at_ms = NULL, user_id = ? WHERE id = ?")
            .bind(otherUser, replacement.session_id),
        ])
      );
      const beforeForeignSession = yield* snapshot();
      yield* Effect.tryPromise(() => run(work));
      expect(activities).toBe(2);
      expect(provider).not.toHaveBeenCalled();
      expect(yield* snapshot()).toEqual(beforeForeignSession);
    })
  ));

it("keeps the old credential when freshness expires or a candidate is already owned", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, seedUser, sendRequest } = yield* Effect.tryPromise(() => setup());
      expect((yield* Effect.tryPromise(() => seedUser())).status).toBe(200);
      const token = "G".repeat(43);
      const started = yield* Effect.tryPromise(() => seedWebSession(db, token));
      const request = replacementRequest(sendRequest, token);
      yield* Effect.tryPromise(() =>
        db
          .prepare("INSERT INTO users VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)")
          .bind("10000000-0000-4000-8000-000000000004", started)
          .run()
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare("INSERT INTO verified_email_credentials VALUES (?, ?, ?)")
          .bind("10000000-0000-4000-8000-000000000004", "owned@example.test", started)
          .run()
      );
      expect(
        (yield* Effect.tryPromise(() =>
          request("/email/replacement", { candidateEmail: "OWNED@example.test" })
        )).status
      ).toBe(200);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM email_replacements").first<{ count: number }>()
        ))?.count
      ).toBe(0);
      expect(
        (yield* Effect.tryPromise(() =>
          request("/email/replacement", { candidateEmail: "free@example.test" })
        )).status
      ).toBe(200);
      const proof = yield* Effect.tryPromise(() => deliverPendingReplacement(db));
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(started + 600_000);
      expect(
        (yield* Effect.tryPromise(() =>
          request("/web/email/replacement/verify", { combinedCode: proof })
        )).status
      ).toBe(401);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT email_address FROM verified_email_credentials WHERE email_address = 'person@example.test'"
            )
            .first()
        )
      ).not.toBeNull();
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT count(*) AS count FROM email_replacement_audit WHERE outcome = 'replaced'"
            )
            .first<{ count: number }>()
        ))?.count
      ).toBe(0);
    })
  ));

it("preserves global mailbox ownership when another User claims the candidate after delivery", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, seedUser, sendRequest } = yield* Effect.tryPromise(() => setup());
      expect((yield* Effect.tryPromise(() => seedUser())).status).toBe(200);
      const token = "H".repeat(43);
      const started = yield* Effect.tryPromise(() => seedWebSession(db, token));
      const request = replacementRequest(sendRequest, token);
      expect(
        (yield* Effect.tryPromise(() =>
          request("/email/replacement", { candidateEmail: "claimed@example.test" })
        )).status
      ).toBe(200);
      const proof = yield* Effect.tryPromise(() => deliverPendingReplacement(db));
      yield* Effect.tryPromise(() =>
        db
          .prepare("INSERT INTO users VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)")
          .bind("10000000-0000-4000-8000-000000000004", started)
          .run()
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare("INSERT INTO verified_email_credentials VALUES (?, ?, ?)")
          .bind("10000000-0000-4000-8000-000000000004", "claimed@example.test", started)
          .run()
      );
      expect(
        (yield* Effect.tryPromise(() =>
          request("/web/email/replacement/verify", { combinedCode: proof })
        )).status
      ).toBe(400);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT email_address FROM verified_email_credentials WHERE user_id = (SELECT id FROM users WHERE id <> ?)"
            )
            .bind("10000000-0000-4000-8000-000000000004")
            .first()
        ))?.email_address
      ).toBe("person@example.test");
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT count(*) AS count FROM email_replacement_audit WHERE outcome = 'replaced'"
            )
            .first<{ count: number }>()
        ))?.count
      ).toBe(0);
    })
  ));

it("bounds replacement delivery across rejected proofs for the same User", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, seedUser, sendRequest } = yield* Effect.tryPromise(() => setup());
      expect((yield* Effect.tryPromise(() => seedUser())).status).toBe(200);
      const token = "J".repeat(43);
      yield* Effect.tryPromise(() => seedWebSession(db, token));
      const request = replacementRequest(sendRequest, token);
      const start = (): Promise<Response> =>
        request("/email/replacement", { candidateEmail: "other@example.test" });

      const rejectGeneration = (): Effect.Effect<void, Cause.UnknownError> =>
        Effect.gen(function* () {
          expect((yield* Effect.tryPromise(start)).status).toBe(200);
          const proof = yield* Effect.tryPromise(() => deliverPendingReplacement(db));
          const wrong = `${proof.slice(0, -1)}${proof.endsWith("A") ? "B" : "A"}`;
          for (let attempt = 0; attempt < 5; attempt++) {
            expect(
              (yield* Effect.tryPromise(() =>
                request("/web/email/replacement/verify", { combinedCode: wrong })
              )).status
            ).toBe(400);
          }
        });
      yield* rejectGeneration();
      yield* rejectGeneration();
      yield* rejectGeneration();
      expect(
        (yield* Effect.tryPromise(() => Promise.all([start(), start()]))).map(
          (response) => response.status
        )
      ).toEqual([200, 200]);
      expect((yield* Effect.tryPromise(() => start())).status).toBe(200);
      const auditRows = yield* Effect.tryPromise(() =>
        db.prepare("SELECT * FROM email_replacement_audit").all()
      );
      expect(encodeJson(auditRows.results)).not.toContain("other@example.test");
      expect(encodeJson(auditRows.results)).not.toContain("__Host-fidy_session");
      expect(auditRows.results.filter((entry) => entry.outcome === "rejected")).toHaveLength(15);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT requests FROM email_replacement_limits").first<{ requests: number }>()
        ))?.requests
      ).toBe(5);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM email_replacement_outbox")
            .first<{ count: number }>()
        ))?.count
      ).toBe(4);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT count(*) AS count FROM email_replacement_audit WHERE operation = 'requestEmailReplacement'"
            )
            .first<{ count: number }>()
        ))?.count
      ).toBe(6);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT email_address FROM verified_email_credentials").first()
        ))?.email_address
      ).toBe("person@example.test");
    })
  ));

it("rejects unproved support recovery without creating a case or approving a pairing", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, seedUser, sendRequest } = yield* Effect.tryPromise(() => setup());
      expect((yield* Effect.tryPromise(() => seedUser())).status).toBe(200);
      const pairing: { pairingId: string; publicCode: string } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ pairingId: Schema.String, publicCode: Schema.String })
      )(
        yield* startBrowserPairing(db).pipe(
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

it("binds an Access-approved recovery case to one stable User, consumes its code and refuses replay", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, seedUser, sendRequest } = yield* Effect.tryPromise(() => setup());
      const created: { backupRecoveryCode: string } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ backupRecoveryCode: Schema.String })
      )(yield* Effect.tryPromise(() => seedUser().then((awaited2) => awaited2.json())));
      const pairing: { pairingId: string; publicCode: string; privateVerifier: string } =
        yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            pairingId: Schema.String,
            publicCode: Schema.String,
            privateVerifier: Schema.String,
          })
        )(
          yield* startBrowserPairing(db).pipe(
            Effect.flatMap((response) => Effect.tryPromise(() => response.json()))
          )
        );
      const { publicKey, privateKey } = yield* Effect.tryPromise(() => generateKeyPair("RS256"));
      const jwk = {
        ...(yield* Effect.tryPromise(() => exportJWK(publicKey))),
        kid: "support-key",
        alg: "RS256",
        use: "sig",
      };
      vi.spyOn(globalThis, "fetch").mockImplementation(() =>
        Promise.resolve(Response.json({ keys: [jwk] }))
      );

      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const assertion = yield* Effect.tryPromise(() =>
        new SignJWT({})
          .setProtectedHeader({ alg: "RS256", kid: "support-key" })
          .setIssuer("https://example.cloudflareaccess.com")
          .setAudience("test-support-audience")
          .setSubject("test-operator")
          .setIssuedAt(now)
          .setExpirationTime(now + 300)
          .sign(privateKey)
      );
      const approve = (
        backupRecoveryCode: string,
        token = assertion,
        publicCode = pairing.publicCode
      ): Promise<Response> =>
        sendRequest(
          new Request("https://api.fidyapp.com/internal/support-recovery", {
            method: "POST",
            headers: { "content-type": "application/json", "cf-access-jwt-assertion": token },
            body: encodeJson({ pairingCode: publicCode, backupRecoveryCode }),
          })
        );
      expect(
        (yield* Effect.tryPromise(() => approve(created.backupRecoveryCode, `${assertion}invalid`)))
          .status
      ).toBe(401);
      expect(
        (yield* Effect.tryPromise(() => approve("AAAAA-AAAAA-AAAAA-AAAAA-AAAAA"))).status
      ).toBe(400);
      const otherPairing: { pairingId: string; publicCode: string } =
        yield* Schema.decodeUnknownEffect(
          Schema.Struct({ pairingId: Schema.String, publicCode: Schema.String })
        )(
          yield* startBrowserPairing(db).pipe(
            Effect.flatMap((response) => Effect.tryPromise(() => response.json()))
          )
        );
      expect(
        (yield* Effect.tryPromise(() =>
          approve(created.backupRecoveryCode, assertion, "AAAA-AAAA")
        )).status
      ).toBe(400);
      const otherUser = "10000000-0000-4000-8000-000000000099";

      const nowMs = yield* Clock.currentTimeMillis;
      yield* Effect.tryPromise(() =>
        db
          .prepare(`INSERT INTO users (id, service_market, locale, time_zone, created_at_ms)
    VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)`)
          .bind(otherUser, nowMs)
          .run()
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare(`INSERT INTO browser_pairing_email_proofs
    (pairing_id, work_id, user_id, email_address, credential_verified_at_ms, state,
     expires_at_ms, generation, last_requested_at_ms)
    VALUES (?, ?, ?, 'other@example.test', ?, 'awaiting_delivery', ?, 1, ?)`)
          .bind(
            otherPairing.pairingId,
            "10000000-0000-4000-8000-000000000098",
            otherUser,
            nowMs,
            nowMs + 600000,
            nowMs
          )
          .run()
      );
      const conflicting = yield* Effect.tryPromise(() =>
        approve(created.backupRecoveryCode, assertion, otherPairing.publicCode)
      );
      expect(conflicting.status).toBe(400);
      expect(yield* Effect.tryPromise(() => conflicting.text())).not.toContain(
        created.backupRecoveryCode
      );
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT state, user_id FROM browser_login_pairings WHERE id = ?")
            .bind(otherPairing.pairingId)
            .first()
        )
      ).toMatchObject({ state: "pending_approval", user_id: null });
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT consumed_at_ms FROM backup_recovery_credentials").first()
        )
      ).toMatchObject({ consumed_at_ms: null });
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM support_recovery_cases")
            .first<{ count: number }>()
        ))?.count
      ).toBe(0);
      const expiredPairing = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ pairingId: Schema.String, publicCode: Schema.String })
      )(
        yield* startBrowserPairing(db).pipe(
          Effect.flatMap((response) => Effect.tryPromise(() => response.json()))
        )
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "UPDATE browser_login_pairings SET created_at_ms = created_at_ms - 600001, expires_at_ms = created_at_ms - 1 WHERE id = ?"
          )
          .bind(expiredPairing.pairingId)
          .run()
      );
      expect(
        (yield* Effect.tryPromise(() =>
          approve(created.backupRecoveryCode, assertion, expiredPairing.publicCode)
        )).status
      ).toBe(400);
      yield* Effect.tryPromise(() =>
        db
          .prepare(`CREATE TRIGGER reject_recovery_evidence BEFORE INSERT ON support_recovery_events
          WHEN NEW.action = 'approved' BEGIN SELECT RAISE(ABORT, 'recovery evidence unavailable'); END`)
          .run()
      );
      expect((yield* Effect.tryPromise(() => approve(created.backupRecoveryCode))).status).toBe(
        503
      );
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT state, user_id FROM browser_login_pairings WHERE id = ?")
            .bind(pairing.pairingId)
            .first()
        )
      ).toEqual({ state: "pending_approval", user_id: null });
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT consumed_at_ms FROM backup_recovery_credentials").first()
        )
      ).toEqual({ consumed_at_ms: null });
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM support_recovery_cases").first()
        )
      ).toEqual({ count: 0 });
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM support_recovery_events").first()
        )
      ).toEqual({ count: 0 });
      yield* Effect.tryPromise(() => db.prepare("DROP TRIGGER reject_recovery_evidence").run());
      const identitiesBefore = yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT user_id, portfolio_id, bsuid FROM whatsapp_identities ORDER BY user_id")
          .all()
      );
      const competing = yield* Effect.tryPromise(() =>
        Promise.all([approve(created.backupRecoveryCode), approve(created.backupRecoveryCode)])
      );
      expect(competing.filter((result) => result.status === 200)).toHaveLength(1);
      expect(competing.map((result) => result.status).sort((left, right) => left - right)).toEqual([
        200, 400,
      ]);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT state, user_id FROM browser_login_pairings WHERE id = ?")
            .bind(otherPairing.pairingId)
            .first()
        )
      ).toMatchObject({ state: "pending_approval", user_id: null });
      expect((yield* Effect.tryPromise(() => approve(created.backupRecoveryCode))).status).toBe(
        400
      );
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM support_recovery_cases")
            .first<{ count: number }>()
        ))?.count
      ).toBe(1);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM support_recovery_events")
            .first<{ count: number }>()
        ))?.count
      ).toBe(2);
      const subject = yield* Effect.tryPromise(() =>
        db
          .prepare(`SELECT p.user_id AS paired_user, b.user_id AS proof_user,
    b.consumed_at_ms AS consumed FROM browser_login_pairings AS p
    JOIN backup_recovery_credentials AS b ON b.user_id = p.user_id WHERE p.id = ?`)
          .bind(pairing.pairingId)
          .first()
      );
      expect(subject).toMatchObject({ paired_user: subject?.proof_user });
      expect(subject?.consumed).not.toBeNull();
      const redeemWith = (privateVerifier: string): Promise<Response> =>
        sendRequest(
          new Request("https://api.fidyapp.com/web/pairings/redeem", {
            method: "POST",
            headers: { origin: "https://app.fidyapp.com", "content-type": "application/json" },
            body: encodeJson({ pairingId: pairing.pairingId, privateVerifier }),
          })
        );
      for (const wrongPurpose of [created.backupRecoveryCode, "x".repeat(43)]) {
        const rejected = yield* Effect.tryPromise(() => redeemWith(wrongPurpose));
        expect(rejected.status).toBe(400);
        expect(rejected.headers.get("set-cookie")).toBeNull();
      }
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM web_sessions").first()
        )
      ).toEqual({ count: 0 });
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT user_id, portfolio_id, bsuid FROM whatsapp_identities ORDER BY user_id"
            )
            .all()
        )).results
      ).toEqual(identitiesBefore.results);
      expect(
        yield* Effect.tryPromise(() => db.prepare("SELECT count(*) AS count FROM users").first())
      ).toEqual({ count: 2 });
      const caseEvidence = yield* Effect.tryPromise(() =>
        db.prepare("SELECT * FROM support_recovery_events").all()
      );
      expect(encodeJson(caseEvidence.results)).not.toContain(created.backupRecoveryCode);
      expect(encodeJson(caseEvidence.results)).not.toContain(pairing.privateVerifier);
      const redeemed = yield* Effect.tryPromise(() =>
        sendRequest(
          new Request("https://api.fidyapp.com/web/pairings/redeem", {
            method: "POST",
            headers: { origin: "https://app.fidyapp.com", "content-type": "application/json" },
            body: encodeJson({
              pairingId: pairing.pairingId,
              privateVerifier: pairing.privateVerifier,
            }),
          })
        )
      );
      expect(redeemed.status).toBe(200);
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
      const { db, seedUser, sendRequest } = yield* Effect.tryPromise(() =>
        setup("person@example.test", "CO.Person1", {
          worker: makeCoreWorker(telemetry),
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
        yield* startBrowserPairing(db).pipe(
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
        handleSupportRecovery({ request: request(), db: database(db), config })
      );
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
      failure = "defect";
      const returned = yield* Effect.tryPromise(() => sendRequest(request()));
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
      failure = "d1";
      expect((yield* Effect.tryPromise(() => sendRequest(request()))).status).toBe(503);
      expect(failures).toHaveLength(1);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM support_recovery_cases")
            .first<{ count: number }>()
        ))?.count
      ).toBe(0);
    })
  ));

it("does not impose a shared login lockout after concurrent pairing starts", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Effect.tryPromise(() => setup());
      const starts = yield* Effect.all(
        Array.from({ length: 101 }, () => startBrowserPairing(db)),
        { concurrency: 101 }
      );
      expect(starts.every((response) => response.status === 200)).toBe(true);
      expect((yield* startBrowserPairing(db)).status).toBe(200);
    })
  ));

it("invalidates a browser pairing after five incorrect private verifiers", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, seedUser, sendRequest } = yield* Effect.tryPromise(() => setup());
      const request = (proof: unknown): Promise<Response> =>
        sendRequest(
          new Request("https://api.fidyapp.com/web/pairings/redeem", {
            method: "POST",
            headers: { "content-type": "application/json", origin: "https://app.fidyapp.com" },
            body: JSON.stringify(proof),
          })
        );
      const started = yield* Effect.tryPromise(() =>
        sendRequest(
          new Request("https://api.fidyapp.com/web/pairings", {
            method: "POST",
            headers: { "content-type": "application/json", origin: "https://app.fidyapp.com" },
            body: "{}",
          })
        )
      );
      expect(started.status).toBe(200);
      const pairing: { pairingId: string; privateVerifier: string } =
        yield* Schema.decodeUnknownEffect(
          Schema.Struct({ pairingId: Schema.String, privateVerifier: Schema.String })
        )(yield* Effect.tryPromise(() => started.json()));
      const rejectFive = (target: typeof pairing): Effect.Effect<void, Cause.UnknownError> =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 5; attempt++) {
            expect(
              (yield* Effect.tryPromise(() =>
                request({ pairingId: target.pairingId, privateVerifier: "A".repeat(43) })
              )).status
            ).toBe(400);
          }
        });
      yield* rejectFive(pairing);
      expect((yield* Effect.tryPromise(() => request(pairing))).status).toBe(400);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT state FROM browser_login_pairings WHERE id = ?")
            .bind(pairing.pairingId)
            .first<{ state: string }>()
        ))?.state
      ).toBe("invalidated");
      expect((yield* Effect.tryPromise(() => seedUser())).status).toBe(200);
      const ready: typeof pairing = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ pairingId: Schema.String, privateVerifier: Schema.String })
      )(
        yield* startBrowserPairing(db).pipe(
          Effect.flatMap((response) => Effect.tryPromise(() => response.json()))
        )
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "UPDATE browser_login_pairings SET state = 'ready', user_id = (SELECT id FROM users) WHERE id = ?"
          )
          .bind(ready.pairingId)
          .run()
      );
      yield* rejectFive(ready);
      expect((yield* Effect.tryPromise(() => request(ready))).status).toBe(400);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT state, user_id FROM browser_login_pairings WHERE id = ?")
            .bind(ready.pairingId)
            .first<{ state: string; user_id: unknown }>()
        )
      ).toMatchObject({ state: "invalidated", user_id: null });
    })
  ));

it(
  "reports rejected delivery even when its Workflow completed successfully",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db, seedUser, sendRequest } = yield* Effect.tryPromise(() => setup());
        yield* Effect.tryPromise(() => seedUser());
        const pairing = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ pairingId: Schema.String, privateVerifier: Schema.String })
        )(
          yield* startBrowserPairing(db).pipe(
            Effect.flatMap((response) => Effect.tryPromise(() => response.json()))
          )
        );
        const accepted = yield* Effect.tryPromise(() =>
          sendRequest(
            new Request("https://api.fidyapp.com/web/email/authentication/start", {
              method: "POST",
              headers: { origin: "https://app.fidyapp.com", "content-type": "application/json" },
              body: encodeJson({ ...pairing, email: "person@example.test" }),
            })
          )
        );
        expect(accepted.status).toBe(202);
        const work = yield* Schema.decodeUnknownEffect(Schema.Struct({ work_id: Schema.String }))(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT work_id FROM browser_pairing_email_proofs").first()
          )
        );
        yield* Effect.tryPromise(() =>
          deliverBrowserPairingEmail({ db, send: () => Promise.resolve("rejected") })(work.work_id)
        );
        const signals = yield* observeOperationalHealth({
          DB: db,
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

it("rejects a WebSession revoked during renewal without releasing the User or writing accepted read evidence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, seedUser, sendRequest } = yield* Effect.tryPromise(() => setup());
      expect((yield* Effect.tryPromise(() => seedUser())).status).toBe(200);
      const token = "R".repeat(43);
      yield* Effect.tryPromise(() => seedWebSession(db, token));
      yield* Effect.tryPromise(() =>
        db
          .prepare(`CREATE TRIGGER revoke_during_renewal AFTER UPDATE OF idle_expires_at_ms ON web_sessions
        BEGIN UPDATE web_sessions SET revoked_at_ms = 1 WHERE id = NEW.id; END`)
          .run()
      );
      const response = yield* Effect.tryPromise(() =>
        sendRequest(
          new Request("https://api.fidyapp.com/user", {
            headers: { origin: "https://app.fidyapp.com", cookie: `__Host-fidy_session=${token}` },
          })
        )
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM canonical_user_reads").first()
        )
      ).toEqual({ count: 0 });
    })
  ));

it("redeems one approved pairing under concurrent replay without accepting a fixated browser bearer", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, seedUser, sendRequest } = yield* Effect.tryPromise(() => setup());
      expect((yield* Effect.tryPromise(() => seedUser())).status).toBe(200);
      const oldToken = "F".repeat(43);
      yield* Effect.tryPromise(() => seedWebSession(db, oldToken));
      const pairing = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ pairingId: Schema.String, privateVerifier: Schema.String })
      )(
        yield* startBrowserPairing(db).pipe(
          Effect.flatMap((response) => Effect.tryPromise(() => response.json()))
        )
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "UPDATE browser_login_pairings SET state = 'ready', user_id = (SELECT id FROM users) WHERE id = ?"
          )
          .bind(pairing.pairingId)
          .run()
      );
      const redeem = (): Promise<Response> =>
        sendRequest(
          new Request("https://api.fidyapp.com/web/pairings/redeem", {
            method: "POST",
            headers: {
              origin: "https://app.fidyapp.com",
              "content-type": "application/json",
              cookie: `__Host-fidy_session=${oldToken}`,
            },
            body: encodeJson(pairing),
          })
        );
      yield* Effect.tryPromise(() =>
        db
          .prepare(`CREATE TRIGGER refuse_session BEFORE INSERT ON web_sessions
        BEGIN SELECT RAISE(ABORT, 'session_test_refusal'); END`)
          .run()
      );
      const refused = yield* Effect.tryPromise(() => redeem());
      expect(refused.status).toBe(400);
      expect(refused.headers.get("set-cookie")).toBeNull();
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT state FROM browser_login_pairings WHERE id = ?")
            .bind(pairing.pairingId)
            .first()
        )
      ).toEqual({ state: "ready" });
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM web_sessions WHERE pairing_id = ?")
            .bind(pairing.pairingId)
            .first()
        )
      ).toEqual({ count: 0 });
      yield* Effect.tryPromise(() => db.prepare("DROP TRIGGER refuse_session").run());
      const responses = yield* Effect.tryPromise(() => Promise.all([redeem(), redeem()]));
      expect(
        responses.map((response) => response.status).sort((left, right) => left - right)
      ).toEqual([200, 400]);
      const issued =
        responses.find((response) => response.status === 200)?.headers.get("set-cookie") ?? "";
      expect(issued).toContain("__Host-fidy_session=");
      expect(issued).not.toContain(oldToken);
      expect(issued).toContain("Secure; HttpOnly; SameSite=Lax");
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM web_sessions WHERE pairing_id = ?")
            .bind(pairing.pairingId)
            .first()
        )
      ).toEqual({ count: 1 });
      const replay = yield* Effect.tryPromise(() => redeem());
      expect(replay.status).toBe(400);
      expect(replay.headers.get("set-cookie")).toBeNull();
    })
  ));

// Exercise the published Workflow with only the external Resend transport substituted.
const runProofDelivery =
  (
    kind: "browser-pairing-email" | "email-replacement",
    input: {
      db: D1Database;
      send: (
        to: EmailAddress,
        code: EmailVerificationCode,
        id: string
      ) => Promise<"succeeded" | "rejected" | "ambiguous">;
    }
  ) =>
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
    const run =
      kind === "browser-pairing-email"
        ? runBrowserPairingEmailWorkflow
        : runEmailReplacementWorkflow;
    return run({
      environment: { DB: input.db, RESEND_API_KEY: "synthetic-test-provider-key" },
      payload: { kind, version: 1, id },
      activity: (_name, _options, activity) => activity(),
    }).finally(() => provider.mockRestore());
  };
const deliverBrowserPairingEmail = (
  input: Parameters<typeof runProofDelivery>[1]
): ((id: string) => Promise<void>) => runProofDelivery("browser-pairing-email", input);
const deliverEmailReplacement = (
  input: Parameters<typeof runProofDelivery>[1]
): ((id: string) => Promise<void>) => runProofDelivery("email-replacement", input);
