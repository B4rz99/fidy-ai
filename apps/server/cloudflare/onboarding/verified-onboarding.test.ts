import { Miniflare } from "miniflare";
import { afterEach, expect, it, vi } from "vitest";
import { startBrowserPairing } from "../identity/browser-login";
import {
  deliverBrowserPairingEmail,
  dispatchBrowserPairingEmail,
} from "../identity/browser-pairing-email-delivery";
import { Cause, Clock, Effect, Exit, Schema } from "effect";
import {
  deliverEmailReplacement,
  dispatchEmailReplacement,
} from "../identity/email-replacement-delivery";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import coreWorker, { makeCoreWorker } from "../core-worker";
import { DisabledTelemetryResource, makeTelemetryService } from "@fidy/server/telemetry";
import { handleSupportRecovery } from "../identity/support-recovery";
import publicWorker from "../public-worker";
import { approvedWorkersAiModel } from "@fidy/server/hosted-inference-model";

const signWebhook = (secret: string, body: string | Uint8Array): Promise<string> =>
  crypto.subtle
    .importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ])
    .then((key) =>
      crypto.subtle.sign(
        "HMAC",
        key,
        typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body)
      )
    )
    .then((bytes) =>
      Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")
    );

const encodeJson = (value: unknown): string =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value);

const mfInstances: Array<Miniflare> = [];
const exchange = "10000000-0000-4000-8000-000000000001";
const enrollment = "10000000-0000-4000-8000-000000000002";
const code = "ABCD-EFGH-JKLM-NPQR-STUV-WXYZ";
let nextDatabase = 0;
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
  }: {
    worker: typeof coreWorker;
    database: (db: D1Database) => D1Database;
    accessIssuer: string;
  } = {
    worker: coreWorker,
    database: (db: D1Database): D1Database => db,
    accessIssuer: "https://example.cloudflareaccess.com",
  }
): Promise<{
  db: D1Database;
  send: (combinedCode: unknown) => Promise<Response>;
  sendRequest: (request: Request) => Promise<Response>;
}> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const mf = new Miniflare({
        workers: [
          {
            config: {
              compatibilityDate: "2026-09-08",
              env: { DB: { id: `verified-${++nextDatabase}`, type: "d1" } },
              manifest: {
                mainModule: "index.mjs",
                modules: {
                  "index.mjs": {
                    contents: "export default {fetch() {return new Response('ok')}}",
                    type: "esm",
                  },
                },
              },
              name: `verified-${nextDatabase}`,
              type: "worker",
            },
          },
        ],
      });
      mfInstances.push(mf);
      yield* Effect.tryPromise(() => mf.ready);
      const db = yield* Effect.tryPromise(() => mf.getD1Database("DB"));
      const applyMigration = (name: string): Promise<void> =>
        Bun.file(new URL(`../migrations/${name}.sql`, import.meta.url))
          .text()
          .then((sql) =>
            sql
              .replace(/^--.*$/gmu, "")
              .trim()
              .split(/;\s*\n(?=CREATE |ALTER |$)/u)
              .reduce<Promise<void>>(
                (previous, statement) =>
                  previous.then(() => db.prepare(statement).run()).then(() => undefined),
                Promise.resolve()
              )
          );
      // Applied migrations depend on the preceding schema, so they must run in order.
      yield* Effect.tryPromise(() =>
        [
          "0003_pending_consent",
          "0004_onboarding_email",
          "0005_verified_onboarding",
          "0006_browser_login",
          "0007_browser_pairing_email",
          "0008_support_recovery",
          "0009_email_replacement",
        ].reduce<Promise<void>>(
          (previous, name) => previous.then(() => applyMigration(name)),
          Promise.resolve()
        )
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
      yield* Effect.tryPromise(() =>
        digest("JKLM-NPQR-STUV-WXYZ").then((awaited0) =>
          db
            .prepare(`INSERT INTO pending_email_enrollments
    (id,exchange_id,email_address,submission_message_id,submission_body_sha256,created_at_ms,
     expires_at_ms,state,public_code,proof_digest,proof_expires_at_ms)
    VALUES (?,?,?,?,?,?,?,'awaiting_proof',?,?,?)`)
            .bind(
              enrollment,
              exchange,
              email,
              "email",
              "c".repeat(64),
              now - 60000,
              now + 600000,
              "ABCD-EFGH",
              awaited0,
              now + 600000
            )
            .run()
        )
      );
      const sendRequest = (request: Request): Promise<Response> =>
        publicWorker.fetch(request, {
          BROWSER_ORIGIN: "https://app.fidyapp.com",
          LOCAL_CANONICAL_READ_BEARER: "",
          PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
          RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
          CORE: {
            fetch: (request) =>
              worker.fetch(new Request(request), {
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
              }),
          },
        });
      const send = (combinedCode: unknown): Promise<Response> =>
        sendRequest(
          new Request("https://api.fidyapp.com/web/onboarding/email/verify", {
            method: "POST",
            headers: { "content-type": "application/json", origin: "https://app.fidyapp.com" },
            body: encodeJson({ combinedCode }),
          })
        );
      return { db, send, sendRequest };
    })
  );

afterEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      vi.useRealTimers();
      vi.restoreAllMocks();
      yield* Effect.tryPromise(() => Promise.all(mfInstances.splice(0).map((mf) => mf.dispose())));
    })
  )
);

it("creates one complete stable identity on first valid mailbox proof and refuses replay", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* Effect.tryPromise(() => setup());
      const first = yield* Effect.tryPromise(() => send(code));
      expect(first.status).toBe(200);
      const created: { status: string; backupRecoveryCode: string } =
        yield* Schema.decodeUnknownEffect(
          Schema.Struct({ status: Schema.String, backupRecoveryCode: Schema.String })
        )(yield* Effect.tryPromise(() => first.json()));
      expect(created.status).toBe("created");
      expect((yield* Effect.tryPromise(() => send(code))).status).toBe(400);
      const result = yield* Effect.tryPromise(() =>
        db
          .prepare(`SELECT u.service_market, u.locale, u.time_zone,
    w.portfolio_id, w.bsuid, v.email_address, c.disclosure_message_id,
    c.decision_message_id, c.decision_received_at_ms, c.accepted_at_ms,
    t.started_at_ms, t.ends_at_ms, b.code_digest,
    x.enrollment_id
    FROM users AS u JOIN whatsapp_identities AS w ON w.user_id = u.id
    JOIN verified_email_credentials AS v ON v.user_id = u.id
    JOIN onboarding_consent_records AS c ON c.user_id = u.id
    JOIN trial_periods AS t ON t.user_id = u.id
    JOIN backup_recovery_credentials AS b ON b.user_id = u.id
    JOIN completed_email_enrollments AS x ON x.user_id = u.id`)
          .first<{
            ends_at_ms: number;
            started_at_ms: number;
            code_digest: Array<number>;
            accepted_at_ms: number;
            decision_received_at_ms: number;
          }>()
      );
      expect(result).toMatchObject({
        service_market: "CO",
        locale: "es-CO",
        time_zone: "America/Bogota",
        portfolio_id: "portfolio",
        bsuid: "CO.Person1",
        email_address: "person@example.test",
        disclosure_message_id: "disclosure",
        decision_message_id: "decision",
        enrollment_id: enrollment,
      });
      expect(result).not.toBeNull();
      if (result !== null) {
        expect(result.ends_at_ms - result.started_at_ms).toBe(604_800_000);
        expect(result.accepted_at_ms).toBe(result.decision_received_at_ms - 1000);
        expect(result.code_digest).toEqual(
          Array.from(yield* Effect.tryPromise(() => digest(created.backupRecoveryCode)))
        );
      }
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT proof_digest, public_code FROM pending_email_enrollments").first()
        )
      ).toMatchObject({ proof_digest: null, public_code: null });
      yield* Effect.tryPromise(() =>
        db.prepare("DELETE FROM pending_consent_exchanges WHERE id = ?").bind(exchange).run()
      );
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM onboarding_consent_records")
            .first<{ count: number }>()
        ))?.count
      ).toBe(1);
    })
  ));

it("reads the created User through an independently approved browser WebSession", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send, sendRequest } = yield* Effect.tryPromise(() => setup());
      expect((yield* Effect.tryPromise(() => send(code))).status).toBe(200);
      const request = (path: string, body?: object, cookie?: string): Promise<Response> =>
        sendRequest(
          new Request(`https://api.fidyapp.com${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: {
              origin: "https://app.fidyapp.com",
              ...(body === undefined ? {} : { "content-type": "application/json" }),
              ...(cookie === undefined ? {} : { cookie }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          })
        );
      expect((yield* Effect.tryPromise(() => request("/user"))).status).toBe(401);
      const start = yield* Effect.tryPromise(() => request("/web/pairings", {}));
      expect(start.status).toBe(200);
      const pairing: { pairingId: string; privateVerifier: string; publicCode: string } =
        yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            pairingId: Schema.String,
            privateVerifier: Schema.String,
            publicCode: Schema.String,
          })
        )(yield* Effect.tryPromise(() => start.json()));
      const poll = (): Promise<Response> =>
        request("/web/pairings/redeem", {
          pairingId: pairing.pairingId,
          privateVerifier: pairing.privateVerifier,
        });
      expect((yield* Effect.tryPromise(() => poll())).status).toBe(202);
      expect((yield* Effect.tryPromise(() => poll())).status).toBe(429);
      expect(
        (yield* Effect.tryPromise(() =>
          request("/web/pairings/redeem", {
            pairingId: pairing.pairingId,
            privateVerifier: "A".repeat(43),
          })
        )).status
      ).toBe(400);

      const receivedAtSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const body = encodeJson({
        message: {
          id: "wamid.approve",
          timestamp: String(receivedAtSeconds),
          type: "text",
          from_user_id: "CO.Person1",
          text: { body: `Aprueba el código de inicio de sesión ${pairing.publicCode}` },
        },
        conversation: { business_scoped_user_id: "CO.Person1" },
        phone_number_id: "123456789012345",
      });
      const signed = (signature: string, from: string): Promise<Response> =>
        sendRequest(
          new Request("https://api.fidyapp.com/providers/kapso/callback", {
            method: "POST",
            headers: {
              "x-webhook-event": "whatsapp.message.received",
              "x-idempotency-key": "delivery-approve",
              "x-webhook-signature": signature,
            },
            body: from,
          })
        );
      expect((yield* Effect.tryPromise(() => signed("wrong", body))).status).toBe(401);
      const alien = body
        .replaceAll("CO.Person1", "CO.Other2")
        .replace("wamid.approve", "wamid.other");
      const alienSignature = yield* Effect.tryPromise(() =>
        signWebhook("onboarding-test-secret", alien)
      );
      expect((yield* Effect.tryPromise(() => signed(alienSignature, alien))).status).toBe(400);
      vi.useFakeTimers({ toFake: ["Date"] });

      vi.setSystemTime((yield* Clock.currentTimeMillis) + 11_000);
      expect((yield* Effect.tryPromise(() => poll())).status).toBe(202);
      const approvalSignature = yield* Effect.tryPromise(() =>
        signWebhook("onboarding-test-secret", body)
      );
      expect((yield* Effect.tryPromise(() => signed(approvalSignature, body))).status).toBe(200);

      vi.setSystemTime((yield* Clock.currentTimeMillis) + 11_000);
      const completed = yield* Effect.tryPromise(() => poll());
      expect(completed.status).toBe(200);
      const cookie = completed.headers.get("set-cookie");
      expect(cookie).toContain("__Host-fidy_session=");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("Max-Age=2592000");
      expect((yield* Effect.tryPromise(() => poll())).status).toBe(400);
      expect(
        (yield* Effect.tryPromise(() =>
          request("/user", undefined, "__Host-fidy_session=" + "A".repeat(43))
        )).status
      ).toBe(401);
      const current = yield* Effect.tryPromise(() =>
        request("/user", undefined, cookie?.split(";")[0])
      );
      expect(current.status).toBe(200);
      expect(yield* Effect.tryPromise(() => current.json())).toMatchObject({
        data: {
          serviceMarket: "CO",
          locale: "es-CO",
          timeZone: "America/Bogota",
        },
        next: [],
      });
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM web_sessions").first<{ count: number }>()
        ))?.count
      ).toBe(1);
      const activeCookie = cookie?.split(";")[0];
      const rotated = yield* Effect.tryPromise(() =>
        request("/recovery/backup-code/rotate", {}, activeCookie)
      );
      expect(rotated.status).toBe(200);
      const rotation: { data: { status: string; backupRecoveryCode: string } } =
        yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            data: Schema.Struct({ status: Schema.String, backupRecoveryCode: Schema.String }),
          })
        )(yield* Effect.tryPromise(() => rotated.json()));
      expect(rotation.data.status).toBe("rotated");
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT code_digest FROM backup_recovery_credentials").first<{
            code_digest: Array<number>;
          }>()
        ))?.code_digest
      ).toEqual(
        Array.from(yield* Effect.tryPromise(() => digest(rotation.data.backupRecoveryCode)))
      );
      expect(
        (yield* Effect.tryPromise(() => request("/web/session/logout", {}, activeCookie))).status
      ).toBe(204);
      expect(
        (yield* Effect.tryPromise(() => request("/user", undefined, activeCookie))).status
      ).toBe(401);
      expect(
        (yield* Effect.tryPromise(() =>
          sendRequest(new Request("https://api.fidyapp.com/web/pairings", { method: "POST" }))
        )).status
      ).toBe(403);
    })
  ));

const seedWebSession = (db: D1Database, token: string): Promise<number> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const pairing: { pairingId: string } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ pairingId: Schema.String })
      )(
        yield* Effect.tryPromise(() => startBrowserPairing(db).then((awaited1) => awaited1.json()))
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
      const { db, send, sendRequest } = yield* Effect.tryPromise(() => setup());
      expect((yield* Effect.tryPromise(() => send(code))).status).toBe(200);
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
      const { db, send, sendRequest } = yield* Effect.tryPromise(() => setup());
      expect((yield* Effect.tryPromise(() => send(code))).status).toBe(200);
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
      const { db, send, sendRequest } = yield* Effect.tryPromise(() => setup());
      expect((yield* Effect.tryPromise(() => send(code))).status).toBe(200);
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
      const { db, send, sendRequest } = yield* Effect.tryPromise(() => setup());
      expect((yield* Effect.tryPromise(() => send(code))).status).toBe(200);
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

it("replaces one credential only after fresh-session candidate proof and rejects replay", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send, sendRequest } = yield* Effect.tryPromise(() => setup());
      expect((yield* Effect.tryPromise(() => send(code))).status).toBe(200);
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

it("keeps the old credential when freshness expires or a candidate is already owned", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send, sendRequest } = yield* Effect.tryPromise(() => setup());
      expect((yield* Effect.tryPromise(() => send(code))).status).toBe(200);
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
      const { db, send, sendRequest } = yield* Effect.tryPromise(() => setup());
      expect((yield* Effect.tryPromise(() => send(code))).status).toBe(200);
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
      const { db, send, sendRequest } = yield* Effect.tryPromise(() => setup());
      expect((yield* Effect.tryPromise(() => send(code))).status).toBe(200);
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
      const { db, send, sendRequest } = yield* Effect.tryPromise(() => setup());
      expect((yield* Effect.tryPromise(() => send(code))).status).toBe(200);
      const pairing: { pairingId: string; publicCode: string } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ pairingId: Schema.String, publicCode: Schema.String })
      )(
        yield* Effect.tryPromise(() => startBrowserPairing(db).then((awaited0) => awaited0.json()))
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
      const { db, send, sendRequest } = yield* Effect.tryPromise(() => setup());
      const created: { backupRecoveryCode: string } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ backupRecoveryCode: Schema.String })
      )(yield* Effect.tryPromise(() => send(code).then((awaited2) => awaited2.json())));
      const pairing: { pairingId: string; publicCode: string; privateVerifier: string } =
        yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            pairingId: Schema.String,
            publicCode: Schema.String,
            privateVerifier: Schema.String,
          })
        )(
          yield* Effect.tryPromise(() =>
            startBrowserPairing(db).then((awaited1) => awaited1.json())
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
          yield* Effect.tryPromise(() =>
            startBrowserPairing(db).then((awaited0) => awaited0.json())
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
      const { db, send, sendRequest } = yield* Effect.tryPromise(() =>
        setup("person@example.test", "CO.Person1", {
          worker: makeCoreWorker(telemetry),
          database,
          accessIssuer: "https://defect.cloudflareaccess.com",
        })
      );
      const created: { backupRecoveryCode: string } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ backupRecoveryCode: Schema.String })
      )(yield* Effect.tryPromise(() => send(code).then((result) => result.json())));
      const pairing: { publicCode: string } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ publicCode: Schema.String })
      )(yield* Effect.tryPromise(() => startBrowserPairing(db).then((result) => result.json())));
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
      const starts = yield* Effect.tryPromise(() =>
        Promise.all(Array.from({ length: 101 }, () => startBrowserPairing(db)))
      );
      expect(starts.every((response) => response.status === 200)).toBe(true);
      expect((yield* Effect.tryPromise(() => startBrowserPairing(db))).status).toBe(200);
    })
  ));

it("invalidates a browser pairing after five incorrect private verifiers", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send, sendRequest } = yield* Effect.tryPromise(() => setup());
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
      expect((yield* Effect.tryPromise(() => send(code))).status).toBe(200);
      const ready: typeof pairing = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ pairingId: Schema.String, privateVerifier: Schema.String })
      )(
        yield* Effect.tryPromise(() => startBrowserPairing(db).then((awaited0) => awaited0.json()))
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

it("rejects incorrect proofs and conflicting global mailbox ownership without partial identity", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* Effect.tryPromise(() => setup());
      expect((yield* Effect.tryPromise(() => send("ABCD-EFGH-JKLM-NPQR-STUV-WXY2"))).status).toBe(
        400
      );
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM users").first<{ count: number }>()
        ))?.count
      ).toBe(0);
      yield* Effect.tryPromise(() =>
        db
          .prepare("INSERT INTO users VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)")
          .bind("10000000-0000-4000-8000-000000000004", 1)
          .run()
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare("INSERT INTO verified_email_credentials VALUES (?, ?, ?)")
          .bind("10000000-0000-4000-8000-000000000004", "person@example.test", 1)
          .run()
      );
      expect((yield* Effect.tryPromise(() => send(code))).status).toBe(400);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM users").first<{ count: number }>()
        ))?.count
      ).toBe(1);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM completed_email_enrollments")
            .first<{ count: number }>()
        ))?.count
      ).toBe(0);
    })
  ));

it("refuses an already-owned WhatsAppIdentity without consuming another User's proof", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* Effect.tryPromise(() => setup());
      const other = "10000000-0000-4000-8000-000000000004";
      yield* Effect.tryPromise(() =>
        db
          .prepare("INSERT INTO users VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)")
          .bind(other, 1)
          .run()
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare("INSERT INTO whatsapp_identities VALUES (?, ?, ?, ?)")
          .bind(other, "portfolio", "CO.Person1", 1)
          .run()
      );
      expect((yield* Effect.tryPromise(() => send(code))).status).toBe(400);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM users").first<{ count: number }>()
        ))?.count
      ).toBe(1);
      expect(
        (yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM completed_email_enrollments")
            .first<{ count: number }>()
        ))?.count
      ).toBe(0);
    })
  ));

it("serializes simultaneous redemptions so only one User receives the proof", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* Effect.tryPromise(() => setup());
      const results = yield* Effect.tryPromise(() => Promise.all([send(code), send(code)]));
      expect(results.map((result) => result.status).sort((left, right) => left - right)).toEqual([
        200, 400,
      ]);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM users").first<{ count: number }>()
        ))?.count
      ).toBe(1);
    })
  ));

it("bounds failed mailbox proofs and never creates a User after the fourth attempt", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* Effect.tryPromise(() => setup());
      const wrong = "ABCD-EFGH-JKLM-NPQR-STUV-WXY2";
      const attempts = yield* Effect.tryPromise(() =>
        Promise.all([send(wrong), send(wrong), send(wrong), send(wrong)])
      );
      expect(attempts.map((response) => response.status)).toEqual([400, 400, 400, 400]);
      expect((yield* Effect.tryPromise(() => send(code))).status).toBe(400);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT wrong_proof_attempts, proof_digest FROM pending_email_enrollments")
            .first()
        )
      ).toMatchObject({ wrong_proof_attempts: 4, proof_digest: null });
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM users").first<{ count: number }>()
        ))?.count
      ).toBe(0);
    })
  ));

it("rejects an oversized streaming request before it can reach D1", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, sendRequest } = yield* Effect.tryPromise(() => setup());
      const oversized = new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(new Uint8Array(513));
          controller.close();
        },
      });
      const result = yield* Effect.tryPromise(() =>
        sendRequest(
          new Request("https://api.fidyapp.com/web/onboarding/email/verify", {
            method: "POST",
            headers: { "content-type": "application/json", origin: "https://app.fidyapp.com" },
            body: oversized,
            duplex: "half",
          })
        )
      );
      expect(result.status).toBe(400);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM users").first<{ count: number }>()
        ))?.count
      ).toBe(0);
    })
  ));

it("refuses expired proof and a withdrawn pending Consent decision without creating a User", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, send } = yield* Effect.tryPromise(() => setup());
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE pending_email_enrollments SET proof_expires_at_ms = ? WHERE id = ?")
          .bind(1, enrollment)
          .run()
      );
      expect((yield* Effect.tryPromise(() => send(code))).status).toBe(400);
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "UPDATE pending_email_enrollments SET proof_expires_at_ms = expires_at_ms WHERE id = ?"
          )
          .bind(enrollment)
          .run()
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE pending_consent_exchanges SET state = 'declined' WHERE id = ?")
          .bind(exchange)
          .run()
      );
      expect((yield* Effect.tryPromise(() => send(code))).status).toBe(400);
      expect(
        (yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS count FROM users").first<{ count: number }>()
        ))?.count
      ).toBe(0);
    })
  ));
