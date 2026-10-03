import { newId } from "../secret-material/operations";
import { wompiOutboundHttp } from "./internal/wompi-runtime";
import { UnknownJsonString } from "../../src/shell/schema-codecs/contract";
import { type Miniflare } from "miniflare";
import { afterEach, expect, it, vi } from "vitest";
import {
  PaymentEnrollment,
  PaymentRequestId,
  PaymentSubmission,
} from "../../src/core/subscription/contract";
import { UserId } from "../../src/core/identity/contract";
import { Clock, Config, Data, DateTime, Effect, Option, Schema } from "effect";
import { billingAttemptIdFor } from "./internal/payment-enrollment";
import {
  handlePaymentEnrollment,
  reconcileBillingCandidates,
  runBillingCollectionWorkflow,
  sweepExpiredEnrollmentAdmission,
} from "./runtime";
import { browserOrigins, localCanonicalReadBearer } from "../runtime/contract";
import { makePublicWorker } from "../public-worker";
import { cloudflareWorkerTelemetry } from "../runtime/telemetry/operations";
import { makePaymentEnrollmentD1 } from "./payment-enrollment-d1.test-fixture";

class TestPromiseFailure extends Data.TaggedError("TestPromiseFailure") {}
const fromTestPromise = <A>(promise: () => PromiseLike<A>): Effect.Effect<A> =>
  Effect.tryPromise({
    try: () => Promise.resolve(promise()),
    catch: () => new TestPromiseFailure(),
  }).pipe(Effect.orDie);
const publicKey = `pub_test_${"f1d7c0de".repeat(3)}`;
const secret = `prv_test_${"f1d7c0de".repeat(3)}`;
const token = "A".repeat(43);
const userA = "10000000-0000-4000-8000-000000000001";
const userB = "10000000-0000-4000-8000-000000000002";
const priceId = "22700000-0000-4000-8000-000000000001";
const acceptance = (url: string, hash: string): string =>
  `header.${btoa(JSON.stringify({ permalink: url, file_hash: hash }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "")}.signature`;
const merchant = JSON.stringify({
  data: {
    presigned_acceptance: {
      acceptance_token: acceptance("https://wompi.example/end.pdf", "2".repeat(64)),
      permalink: "https://wompi.example/end.pdf",
    },
    presigned_personal_data_auth: {
      acceptance_token: acceptance("https://wompi.example/data.pdf", "3".repeat(64)),
      permalink: "https://wompi.example/data.pdf",
    },
  },
});
let counter = 0;
const instances: Array<Miniflare> = [];

afterEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      vi.unstubAllGlobals();
      yield* fromTestPromise(() => Promise.all(instances.splice(0).map((mf) => mf.dispose())));
    })
  )
);

const setup = (): Promise<{
  db: D1Database;
  environment: {
    onAccepted: (id: string) => void;
    DB: D1Database;
    BROWSER_ORIGIN: string;
    WOMPI_ENVIRONMENT: string;
    WOMPI_PUBLIC_KEY: string;
    WOMPI_PRIVATE_KEY: string;
    WOMPI_INTEGRITY_SECRET: string;
  };
  request: (path: string, method?: string, body?: object) => Request;
}> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const name = `card-flow-${++counter}`;
      const { db, instance } = yield* makePaymentEnrollmentD1(name, [
        "CREATE TABLE users (id TEXT PRIMARY KEY, time_zone TEXT NOT NULL, service_market TEXT NOT NULL DEFAULT 'CO', locale TEXT NOT NULL DEFAULT 'es-CO') STRICT",
        "CREATE TABLE verified_email_credentials (user_id TEXT PRIMARY KEY, email_address TEXT NOT NULL) STRICT",
        "CREATE TABLE onboarding_consent_records (user_id TEXT PRIMARY KEY) STRICT",
        "CREATE TABLE consent_user_revocations (user_id TEXT PRIMARY KEY) STRICT",
        `CREATE TABLE web_sessions (id TEXT NOT NULL, user_id TEXT NOT NULL, token_digest BLOB NOT NULL,
      revoked_at_ms INTEGER, fresh_until_ms INTEGER NOT NULL, idle_expires_at_ms INTEGER NOT NULL,
      hard_expires_at_ms INTEGER NOT NULL) STRICT`,
      ]);
      instances.push(instance);
      yield* fromTestPromise(() =>
        db
          .prepare(
            "INSERT INTO users (id, time_zone) VALUES (?, 'America/Bogota'), (?, 'America/Bogota')"
          )
          .bind(userA, userB)
          .run()
      );
      yield* fromTestPromise(() =>
        db
          .prepare(
            "INSERT INTO verified_email_credentials VALUES (?, 'payer@example.com'), (?, 'other@example.com')"
          )
          .bind(userA, userB)
          .run()
      );
      yield* fromTestPromise(() =>
        db
          .prepare("INSERT INTO onboarding_consent_records VALUES (?), (?)")
          .bind(userA, userB)
          .run()
      );
      const digest = new Uint8Array(
        yield* fromTestPromise(() =>
          crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
        )
      );
      const now = yield* Clock.currentTimeMillis;
      yield* fromTestPromise(() =>
        db
          .prepare("INSERT INTO web_sessions VALUES (?, ?, ?, NULL, ?, ?, ?)")
          .bind(
            "20000000-0000-4000-8000-000000000001",
            userA,
            digest,
            now + 600_000,
            now + 600_000,
            now + 600_000
          )
          .run()
      );
      const environment = {
        onAccepted: (): void => undefined,
        DB: db,
        BROWSER_ORIGIN: browserOrigins.local,
        WOMPI_ENVIRONMENT: "sandbox",
        WOMPI_PUBLIC_KEY: publicKey,
        WOMPI_PRIVATE_KEY: secret,
        WOMPI_INTEGRITY_SECRET: `test_integrity_${"f1d7c0de".repeat(3)}`,
      };
      const request = (path: string, method = "GET", body?: object): Request =>
        new Request(`https://core.internal${path}`, {
          method,
          headers: {
            origin: browserOrigins.local,
            cookie: `__Host-fidy_session=${token}`,
            "content-type": "application/json",
          },
          ...(body === undefined
            ? {}
            : {
                body: JSON.stringify({
                  ...(path.endsWith("/prepare") ||
                  (path.endsWith("/submit") &&
                    !("paymentSourceMode" in body && body.paymentSourceMode === "reuse"))
                    ? { method: "card" }
                    : {}),
                  ...body,
                }),
              }),
        });
      return { db, environment, request };
    })
  );

it("hides and refuses production DaviPlata until activation and reviewed OTP destinations are configured", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, environment, request } = yield* fromTestPromise(setup);
      const provider = vi.fn(() => Promise.resolve(new Response(merchant)));
      vi.stubGlobal("fetch", provider);
      const production = {
        ...environment,
        WOMPI_ENVIRONMENT: "production",
        WOMPI_PUBLIC_KEY: publicKey.replace("pub_test_", "pub_prod_"),
        WOMPI_PRIVATE_KEY: secret.replace("prv_test_", "prv_prod_"),
        WOMPI_INTEGRITY_SECRET: "prod_integrity_fixture_key",
      };
      const availability = yield* fromTestPromise(() =>
        handlePaymentEnrollment({
          request: request("/web/subscription/payment-enrollments/availability"),
          environment: production,
        })
      );
      expect(availability.status).toBe(200);
      expect(yield* fromTestPromise(() => availability.json())).toEqual({
        enabledMethods: ["card", "nequi"],
      });
      const refused = yield* fromTestPromise(() =>
        handlePaymentEnrollment({
          request: request("/web/subscription/payment-enrollments/prepare", "POST", {
            priceId,
            method: "daviplata",
          }),
          environment: production,
        })
      );
      expect(refused.status).toBe(503);
      expect(provider).not.toHaveBeenCalled();
      expect(
        yield* fromTestPromise(() =>
          db.prepare("SELECT count(*) AS count FROM card_enrollments").first()
        )
      ).toEqual({ count: 0 });
    })
  ));

it("requires Nequi approval before creating a reusable source and collecting one first payment", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, environment, request } = yield* fromTestPromise(setup);
      let approved = false;
      let sourceCreations = 0;
      const provider = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname.startsWith("/v1/merchants/")) {
          return Promise.resolve(new Response(merchant));
        }
        if (url.pathname.startsWith("/v1/tokens/nequi/")) {
          return Promise.resolve(
            Response.json({
              data: {
                id: "nequi_test_browser_only",
                status: approved ? "APPROVED" : "PENDING",
                phone_number: "3991111111",
              },
            })
          );
        }
        const available = Response.json({
          data: {
            id: 3891,
            type: "NEQUI",
            status: "AVAILABLE",
            customer_email: "payer@example.com",
          },
        });
        if (init?.method === "POST") {
          sourceCreations++;
          return new Request(input, init).json().then((body: unknown) => {
            expect(body).toMatchObject({ type: "NEQUI", token: "nequi_test_browser_only" });
            return available;
          });
        }
        return Promise.resolve(available);
      });
      vi.stubGlobal("fetch", provider);
      const preparedResponse = yield* fromTestPromise(() =>
        handlePaymentEnrollment({
          request: request("/web/subscription/payment-enrollments/prepare", "POST", {
            priceId,
            method: "nequi",
          }),
          environment,
        })
      );
      const prepared = yield* fromTestPromise(() => preparedResponse.json());
      expect(preparedResponse.status).toBe(200);
      const enrollmentId = (yield* Schema.decodeUnknownEffect(
        Schema.toCodecJson(PaymentEnrollment)
      )(prepared)).enrollmentId;
      const payload = {
        enrollmentId,
        method: "nequi",
        paymentSourceMode: "create",
        nequiToken: "nequi_test_browser_only",
        paymentRequestId: "40000000-0000-4000-8000-000000000008",
        billingEmail: "payer@example.com",
        decisions: {
          acceptedEndUserPolicy: true,
          acceptedPersonalDataAuthorization: true,
          authorizedRecurringCharges: true,
        },
      };
      const pending = yield* fromTestPromise(() =>
        handlePaymentEnrollment({
          request: request("/web/subscription/payment-enrollments/submit", "POST", payload),
          environment,
        })
      );
      expect(pending.status).toBe(400);
      expect(sourceCreations).toBe(0);
      approved = true;
      const accepted = yield* fromTestPromise(() =>
        handlePaymentEnrollment({
          request: request("/web/subscription/payment-enrollments/submit", "POST", payload),
          environment,
        })
      );
      expect(accepted.status).toBe(200);
      expect(yield* fromTestPromise(() => accepted.json())).toMatchObject({
        status: "payment-pending",
        billingAttempt: { status: "pending" },
      });
      const replay = yield* fromTestPromise(() =>
        handlePaymentEnrollment({
          request: request("/web/subscription/payment-enrollments/submit", "POST", payload),
          environment,
        })
      );
      expect(replay.status).toBe(200);
      expect(sourceCreations).toBe(1);
      expect(
        yield* fromTestPromise(() =>
          db.prepare("SELECT count(*) AS count FROM billing_attempts").first()
        )
      ).toEqual({ count: 1 });
      const retained = yield* fromTestPromise(() =>
        db.prepare("SELECT * FROM card_enrollments").all()
      );
      const retainedText = yield* Schema.encodeEffect(UnknownJsonString)(retained.results);
      expect(retainedText).not.toContain("nequi_test_browser_only");
      expect(retainedText).not.toContain("3991111111");
    })
  ));

const daviplataFixturePolicy = {
  WOMPI_DAVIPLATA_OTP_SEND_URL: "https://sandbox.wompi.co/daviplata/send",
  WOMPI_DAVIPLATA_OTP_CONFIRM_URL: "https://sandbox.wompi.co/daviplata/confirm",
} as const;

it.each([
  { period: "weekly", price: "22700000-0000-4000-8000-000000000001", cents: 990_000 },
  { period: "monthly", price: "22700000-0000-4000-8000-000000000002", cents: 2_890_000 },
  { period: "yearly", price: "22700000-0000-4000-8000-000000000003", cents: 28_990_000 },
])(
  "activates $period Pro only after verified DaviPlata collection, never authorization alone",
  (scenario) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* fromTestPromise(setup);
        const environment = { ...fixture.environment, ...daviplataFixturePolicy };
        let approved = false;
        let sourceCreations = 0;
        let chargeCreations = 0;
        const chargeFacts = Schema.Struct({
          reference: Schema.String,
          amount_in_cents: Schema.Int,
          currency: Schema.String,
          payment_source_id: Schema.Int,
        });
        let charge = Option.none<typeof chargeFacts.Type>();
        const finalizedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
        const available = (): Response =>
          Response.json({
            data: {
              id: 8276,
              type: "DAVIPLATA",
              status: "AVAILABLE",
              customer_email: "payer@example.com",
              token: "daviplata_devtest_once",
              public_data: { number_document: "document-canary", phone_number: "product-canary" },
            },
          });
        const respondTransaction = (
          input: RequestInfo | URL,
          init?: RequestInit
        ): Promise<Response> => {
          if (init?.method === "POST") {
            chargeCreations++;
            return new Request(input, init).json().then((body: unknown) => {
              expect(body).not.toHaveProperty("payment_method");
              const decoded = Schema.decodeUnknownSync(chargeFacts)(body);
              charge = Option.some(decoded);
              expect(decoded.amount_in_cents).toBe(scenario.cents);
              return Response.json({
                data: {
                  id: "daviplata-transaction",
                  ...decoded,
                  status: "PENDING",
                  finalized_at: null,
                },
              });
            });
          }
          if (Option.isNone(charge)) return Promise.reject(new TestPromiseFailure());
          return Promise.resolve(
            Response.json({
              data: {
                id: "daviplata-transaction",
                ...charge.value,
                status: "APPROVED",
                finalized_at: finalizedAt,
              },
            })
          );
        };
        vi.stubGlobal(
          "fetch",
          (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.pathname.startsWith("/v1/merchants/")) {
              return Promise.resolve(new Response(merchant));
            }
            if (url.pathname.startsWith("/v1/tokens/daviplata/")) {
              return Promise.resolve(
                Response.json({
                  data: {
                    id: "daviplata_devtest_once",
                    status: approved ? "APPROVED" : "PENDING",
                    client_info: {
                      number_document: "document-canary",
                      phone_number: "product-canary",
                    },
                  },
                })
              );
            }
            if (url.pathname === "/v1/payment_sources") {
              sourceCreations++;
              return new Request(input, init).json().then((body: unknown) => {
                expect(body).toMatchObject({ type: "DAVIPLATA", token: "daviplata_devtest_once" });
                return available();
              });
            }
            if (url.pathname.startsWith("/v1/payment_sources/")) {
              return Promise.resolve(available());
            }
            return respondTransaction(input, init);
          }
        );
        const preparedResponse = yield* fromTestPromise(() =>
          handlePaymentEnrollment({
            environment,
            request: fixture.request("/web/subscription/payment-enrollments/prepare", "POST", {
              priceId: scenario.price,
              method: "daviplata",
            }),
          })
        );
        expect(preparedResponse.status).toBe(200);
        const prepared = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(PaymentEnrollment))(
          yield* fromTestPromise(() => preparedResponse.json())
        );
        expect(prepared).toMatchObject({
          method: "daviplata",
          status: "prepared",
          daviplataOtpPolicy: {
            sendUrl: daviplataFixturePolicy.WOMPI_DAVIPLATA_OTP_SEND_URL,
            confirmUrl: daviplataFixturePolicy.WOMPI_DAVIPLATA_OTP_CONFIRM_URL,
          },
        });
        const payload = {
          enrollmentId: prepared.enrollmentId,
          method: "daviplata",
          paymentSourceMode: "create",
          daviplataToken: "daviplata_devtest_once",
          paymentRequestId: "40000000-0000-4000-8000-000000000032",
          billingEmail: "payer@example.com",
          decisions: {
            acceptedEndUserPolicy: true,
            acceptedPersonalDataAuthorization: true,
            authorizedRecurringCharges: true,
          },
        };
        const send = (): Promise<Response> =>
          handlePaymentEnrollment({
            environment,
            request: fixture.request(
              "/web/subscription/payment-enrollments/submit",
              "POST",
              payload
            ),
          });
        expect((yield* fromTestPromise(send)).status).toBe(400);
        expect(sourceCreations).toBe(0);
        approved = true;
        const response = yield* fromTestPromise(send);
        expect(response.status).toBe(200);
        const submission = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(PaymentSubmission))(
          yield* fromTestPromise(() => response.json())
        );
        if (submission.status !== "payment-pending") {
          return yield* Effect.die("missing pending collection");
        }
        expect(submission.billingAttempt.status).toBe("pending");
        expect(
          yield* fromTestPromise(() =>
            environment.DB.prepare("SELECT count(*) AS count FROM billing_paid_periods").first()
          )
        ).toEqual({ count: 0 });
        expect((yield* fromTestPromise(send)).status).toBe(200);
        expect(sourceCreations).toBe(1);
        yield* fromTestPromise(() =>
          runBillingCollectionWorkflow({
            environment,
            payload: { version: 1, attemptId: submission.billingAttempt.id },
            activity: (_name, _options, run) => run(),
          })
        );
        const settled = yield* fromTestPromise(() =>
          handlePaymentEnrollment({
            environment,
            request: fixture.request(
              `/web/subscription/billing-attempts/${submission.billingAttempt.id}`
            ),
          })
        );
        expect(yield* fromTestPromise(() => settled.json())).toMatchObject({
          status: "succeeded",
          billingPeriod: scenario.period,
        });
        expect(chargeCreations).toBe(1);
        const retained = yield* fromTestPromise(() =>
          environment.DB.prepare("SELECT * FROM card_enrollments").all()
        );
        const retainedText = yield* Schema.encodeEffect(UnknownJsonString)(retained.results);
        for (const secretValue of ["daviplata_devtest_once", "document-canary", "product-canary"]) {
          expect(retainedText).not.toContain(secretValue);
        }
      })
    )
);

const secondUserRequest = (db: D1Database, request: Request): Promise<Request> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const bearer = "B".repeat(43);
      const digest = new Uint8Array(
        yield* fromTestPromise(() =>
          crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer))
        )
      );
      const now = yield* Clock.currentTimeMillis;
      yield* fromTestPromise(() =>
        db
          .prepare("INSERT OR IGNORE INTO web_sessions VALUES (?, ?, ?, NULL, ?, ?, ?)")
          .bind(
            "20000000-0000-4000-8000-000000000002",
            userB,
            digest,
            now + 600_000,
            now + 600_000,
            now + 600_000
          )
          .run()
      );
      return withHeader(request, "cookie", `__Host-fidy_session=${bearer}`);
    })
  );

it.each(["nequi", "daviplata"] as const)(
  "isolates %s intents and rejects reuse of one approved authorization by a second User",
  (method) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db, environment: baseEnvironment, request } = yield* fromTestPromise(setup);
        const environment = { ...baseEnvironment, ...daviplataFixturePolicy };
        const authorizationToken =
          method === "nequi" ? "nequi_test_once" : "daviplata_devtest_once";
        const tokenPayload =
          method === "nequi"
            ? { nequiToken: authorizationToken }
            : { daviplataToken: authorizationToken };
        let posts = 0;
        vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input instanceof Request ? input.url : input.toString();
          if (url.includes("/merchants/")) return Promise.resolve(new Response(merchant));
          if (url.includes(`/tokens/${method}/`)) {
            return Promise.resolve(
              Response.json({ data: { id: authorizationToken, status: "APPROVED" } })
            );
          }
          if (init?.method === "POST") posts++;
          return Promise.resolve(
            Response.json({
              data: {
                id: 3891,
                type: method === "nequi" ? "NEQUI" : "DAVIPLATA",
                status: "AVAILABLE",
                customer_email: "payer@example.com",
              },
            })
          );
        });
        const prepared = yield* fromTestPromise(() =>
          handlePaymentEnrollment({
            request: request("/web/subscription/payment-enrollments/prepare", "POST", {
              priceId,
              method,
            }),
            environment,
          })
        );
        const ownerEnrollment = yield* Schema.decodeUnknownEffect(
          Schema.toCodecJson(PaymentEnrollment)
        )(yield* fromTestPromise(() => prepared.json()));
        const payload = {
          enrollmentId: ownerEnrollment.enrollmentId,
          method,
          paymentSourceMode: "create",
          ...tokenPayload,
          billingEmail: "payer@example.com",
          paymentRequestId: "40000000-0000-4000-8000-000000000011",
          decisions: {
            acceptedEndUserPolicy: true,
            acceptedPersonalDataAuthorization: true,
            authorizedRecurringCharges: true,
          },
        };
        const foreign = yield* fromTestPromise(() =>
          secondUserRequest(
            db,
            request(`/web/subscription/payment-enrollments/${ownerEnrollment.enrollmentId}`)
          )
        );
        expect(
          (yield* fromTestPromise(() => handlePaymentEnrollment({ request: foreign, environment })))
            .status
        ).toBe(400);
        const foreignSubmit = yield* fromTestPromise(() =>
          secondUserRequest(
            db,
            request("/web/subscription/payment-enrollments/submit", "POST", payload)
          )
        );
        expect(
          (yield* fromTestPromise(() =>
            handlePaymentEnrollment({ request: foreignSubmit, environment })
          )).status
        ).toBe(400);
        expect(posts).toBe(0);
        expect(
          (yield* fromTestPromise(() =>
            handlePaymentEnrollment({
              request: request("/web/subscription/payment-enrollments/submit", "POST", payload),
              environment,
            })
          )).status
        ).toBe(200);
        const prepareB = yield* fromTestPromise(() =>
          secondUserRequest(
            db,
            request("/web/subscription/payment-enrollments/prepare", "POST", {
              priceId,
              method,
            })
          )
        );
        const bResponse = yield* fromTestPromise(() =>
          handlePaymentEnrollment({ request: prepareB, environment })
        );
        const foreignEnrollment = yield* Schema.decodeUnknownEffect(
          Schema.toCodecJson(PaymentEnrollment)
        )(yield* fromTestPromise(() => bResponse.json()));
        const replay = yield* fromTestPromise(() =>
          secondUserRequest(
            db,
            request("/web/subscription/payment-enrollments/submit", "POST", {
              ...payload,
              enrollmentId: foreignEnrollment.enrollmentId,
              billingEmail: "other@example.com",
            })
          )
        );
        expect(
          (yield* fromTestPromise(() => handlePaymentEnrollment({ request: replay, environment })))
            .status
        ).toBe(503);
        expect(posts).toBe(1);
        expect(
          yield* fromTestPromise(() =>
            db
              .prepare("SELECT count(*) AS count FROM billing_attempts WHERE user_id = ?")
              .bind(userB)
              .first()
          )
        ).toEqual({ count: 0 });
      })
    )
);

it("does not schedule a Nequi charge when the fresh session is revoked during source verification", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, environment, request } = yield* fromTestPromise(setup);
      vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url.includes("/merchants/")) return Promise.resolve(new Response(merchant));
        if (url.includes("/tokens/nequi/")) {
          return Promise.resolve(
            Response.json({ data: { id: "nequi_test_revoke", status: "APPROVED" } })
          );
        }
        if (url.includes("/payment_sources/")) {
          return db
            .prepare("UPDATE web_sessions SET revoked_at_ms = 1 WHERE user_id = ?")
            .bind(userA)
            .run()
            .then(() =>
              Response.json({
                data: {
                  id: 3891,
                  type: "NEQUI",
                  status: "AVAILABLE",
                  customer_email: "payer@example.com",
                },
              })
            );
        }
        return Promise.resolve(Response.json({ data: { id: 3891, status: "AVAILABLE" } }));
      });
      const preparedResponse = yield* fromTestPromise(() =>
        handlePaymentEnrollment({
          request: request("/web/subscription/payment-enrollments/prepare", "POST", {
            priceId,
            method: "nequi",
          }),
          environment,
        })
      );
      const prepared = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(PaymentEnrollment))(
        yield* fromTestPromise(() => preparedResponse.json())
      );
      const response = yield* fromTestPromise(() =>
        handlePaymentEnrollment({
          request: request("/web/subscription/payment-enrollments/submit", "POST", {
            enrollmentId: prepared.enrollmentId,
            method: "nequi",
            paymentSourceMode: "create",
            nequiToken: "nequi_test_revoke",
            billingEmail: "payer@example.com",
            paymentRequestId: "40000000-0000-4000-8000-000000000012",
            decisions: {
              acceptedEndUserPolicy: true,
              acceptedPersonalDataAuthorization: true,
              authorizedRecurringCharges: true,
            },
          }),
          environment,
        })
      );
      expect(response.status).toBe(503);
      expect(
        yield* fromTestPromise(() =>
          db.prepare("SELECT count(*) AS count FROM billing_attempts").first()
        )
      ).toEqual({ count: 0 });
      expect(
        yield* fromTestPromise(() =>
          db.prepare("SELECT count(*) AS count FROM billing_collection_outbox").first()
        )
      ).toEqual({ count: 0 });
      expect(
        yield* fromTestPromise(() =>
          db.prepare("SELECT count(*) AS count FROM card_payment_sources").first()
        )
      ).toEqual({ count: 0 });
    })
  ));

it.each(["missing-consent", "revoked-consent", "stale-session"] as const)(
  "rejects Nequi %s before provider egress",
  (failure) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db, environment, request } = yield* fromTestPromise(setup);
        const provider = vi.fn(() => Promise.resolve(new Response(merchant)));
        vi.stubGlobal("fetch", provider);
        const sql = {
          "missing-consent": "DELETE FROM onboarding_consent_records WHERE user_id = ?",
          "revoked-consent": "INSERT INTO consent_user_revocations VALUES (?)",
          "stale-session": "UPDATE web_sessions SET fresh_until_ms = 1 WHERE user_id = ?",
        }[failure];
        yield* fromTestPromise(() => db.prepare(sql).bind(userA).run());
        const denied = yield* fromTestPromise(() =>
          handlePaymentEnrollment({
            environment,
            request: request("/web/subscription/payment-enrollments/prepare", "POST", {
              priceId,
              method: "nequi",
            }),
          })
        );
        expect(denied.status).toBe(401);
        expect(provider).not.toHaveBeenCalled();
        expect(
          yield* fromTestPromise(() =>
            db.prepare("SELECT count(*) AS count FROM card_payment_sources").first()
          )
        ).toEqual({ count: 0 });
      })
    )
);

it.each([
  { stage: "approval", withdrawal: "consent" },
  { stage: "contracts", withdrawal: "consent" },
  { stage: "contracts", withdrawal: "freshness" },
  { stage: "source", withdrawal: "consent" },
  { stage: "approval", withdrawal: "freshness" },
  { stage: "source", withdrawal: "freshness" },
] as const)("rejects mid-flight $withdrawal withdrawal at $stage", (scenario) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, environment, request } = yield* fromTestPromise(setup);
      let posts = 0;
      const withdraw = (): Promise<D1Result> =>
        db
          .prepare(
            scenario.withdrawal === "consent"
              ? "INSERT INTO consent_user_revocations VALUES (?)"
              : "UPDATE web_sessions SET fresh_until_ms = 1 WHERE user_id = ?"
          )
          .bind(userA)
          .run();
      let merchantLookups = 0;
      const merchantResponse = (): Promise<Response> => {
        merchantLookups++;
        return scenario.stage === "contracts" && merchantLookups > 1
          ? withdraw().then(() => new Response(merchant))
          : Promise.resolve(new Response(merchant));
      };
      vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new Request(input, init).url;
        if (url.includes("/merchants/")) return merchantResponse();
        if (url.includes("/tokens/nequi/")) {
          const approved = (): Response =>
            Response.json({ data: { id: "nequi_test_withdraw", status: "APPROVED" } });
          return scenario.stage === "approval"
            ? withdraw().then(approved)
            : Promise.resolve(approved());
        }
        if (init?.method === "POST") posts++;
        const source = (): Response =>
          Response.json({
            data: {
              id: 3891,
              type: "NEQUI",
              status: "AVAILABLE",
              customer_email: "payer@example.com",
            },
          });
        return scenario.stage === "source" && url.includes("/payment_sources/")
          ? withdraw().then(source)
          : Promise.resolve(source());
      });
      const preparedResponse = yield* fromTestPromise(() =>
        handlePaymentEnrollment({
          environment,
          request: request("/web/subscription/payment-enrollments/prepare", "POST", {
            priceId,
            method: "nequi",
          }),
        })
      );
      const prepared = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(PaymentEnrollment))(
        yield* fromTestPromise(() => preparedResponse.json())
      );
      const response = yield* fromTestPromise(() =>
        handlePaymentEnrollment({
          environment,
          request: request("/web/subscription/payment-enrollments/submit", "POST", {
            enrollmentId: prepared.enrollmentId,
            method: "nequi",
            paymentSourceMode: "create",
            nequiToken: "nequi_test_withdraw",
            billingEmail: "payer@example.com",
            paymentRequestId: "40000000-0000-4000-8000-000000000013",
            decisions: {
              acceptedEndUserPolicy: true,
              acceptedPersonalDataAuthorization: true,
              authorizedRecurringCharges: true,
            },
          }),
        })
      );
      expect(response.status).toBe(scenario.stage === "source" ? 503 : 400);
      expect(posts).toBe(scenario.stage === "source" ? 1 : 0);
      for (const table of [
        "card_payment_sources",
        "billing_attempts",
        "billing_collection_outbox",
      ]) {
        expect(
          yield* fromTestPromise(() => db.prepare(`SELECT count(*) AS count FROM ${table}`).first())
        ).toEqual({ count: 0 });
      }
    })
  )
);

const proveSandboxSettlement = (
  input: Readonly<{
    environment: Awaited<ReturnType<typeof setup>>["environment"];
    request: Awaited<ReturnType<typeof setup>>["request"];
    attemptId: string;
    outcome: "approved" | "declined";
  }>
): Effect.Effect<void, TestPromiseFailure> =>
  Effect.gen(function* () {
    const { environment, request, attemptId, outcome } = input;
    const run = (work: unknown): Promise<void> =>
      runBillingCollectionWorkflow({
        environment,
        payload: work,
        activity: (_name, _options, activity) => activity(),
      });
    yield* fromTestPromise(() => run({ version: 1, attemptId }));
    const terminal = outcome === "approved" ? "succeeded" : "failed";
    for (let poll = 0; poll < 8; poll++) {
      const current = yield* fromTestPromise(() =>
        handlePaymentEnrollment({
          environment,
          request: request(`/web/subscription/billing-attempts/${attemptId}`),
        })
      );
      const status = yield* Schema.decodeUnknownEffect(Schema.Struct({ status: Schema.String }))(
        yield* fromTestPromise(() => current.json())
      );
      if (status.status === terminal) {
        expect(
          yield* fromTestPromise(() =>
            environment.DB.prepare(
              "SELECT count(*) AS count FROM billing_paid_periods WHERE attempt_id = ?"
            )
              .bind(attemptId)
              .first()
          )
        ).toEqual({ count: outcome === "approved" ? 1 : 0 });
        return;
      }
      yield* Effect.sleep("61 seconds");
      yield* reconcileBillingCandidates({
        DB: environment.DB,
        BILLING_COLLECTION_WORKFLOW: {
          create: (options) => run(options.params),
          get: () => Promise.reject(new Error("Sandbox workflow unavailable")),
        },
      });
    }
    throw new Error("Sandbox settlement did not reach its expected bounded outcome");
  }).pipe(Effect.mapError(() => new TestPromiseFailure()));

const sandboxTokenResponse = Schema.Struct({
  data: Schema.Struct({ id: Schema.String.check(Schema.isNonEmpty()) }),
});
const sandboxCases = [
  { period: "weekly", priceId: "22700000-0000-4000-8000-000000000001", outcome: "approved" },
  { period: "monthly", priceId: "22700000-0000-4000-8000-000000000002", outcome: "approved" },
  { period: "yearly", priceId: "22700000-0000-4000-8000-000000000003", outcome: "approved" },
  { period: "weekly", priceId: "22700000-0000-4000-8000-000000000001", outcome: "declined" },
] as const;
// Manual, protected Actions proof only. No credentials, bodies or provider identities are reported.
it
  .runIf(Effect.runSync(Config.String("FIDY_NEQUI_SANDBOX").pipe(Config.withDefault("0"))) === "1")
  .each(sandboxCases)(
  "proves Sandbox Nequi $period first payment with $outcome outcome",
  (scenario) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* Effect.all({
          WOMPI_ENVIRONMENT: Config.String("WOMPI_ENVIRONMENT"),
          WOMPI_PUBLIC_KEY: Config.String("WOMPI_PUBLIC_KEY"),
          WOMPI_PRIVATE_KEY: Config.String("WOMPI_PRIVATE_KEY"),
          WOMPI_INTEGRITY_SECRET: Config.String("WOMPI_INTEGRITY_SECRET"),
        }).pipe(Effect.mapError(() => new TestPromiseFailure()));
        if (provider.WOMPI_ENVIRONMENT !== "sandbox") {
          throw new Error("Sandbox configuration required");
        }
        const fixture = yield* fromTestPromise(setup);
        const environment = {
          ...fixture.environment,
          WOMPI_ENVIRONMENT: "sandbox" as const,
          WOMPI_PUBLIC_KEY: provider.WOMPI_PUBLIC_KEY,
          WOMPI_PRIVATE_KEY: provider.WOMPI_PRIVATE_KEY,
          WOMPI_INTEGRITY_SECRET: provider.WOMPI_INTEGRITY_SECRET,
        };
        const outbound = yield* wompiOutboundHttp(environment).pipe(
          Effect.mapError(() => new TestPromiseFailure())
        );
        const tokenResponse = yield* outbound
          .execute({ _tag: "WompiNequiSandboxToken", outcome: scenario.outcome })
          .pipe(Effect.mapError(() => new TestPromiseFailure()));
        expect(tokenResponse.status).toBeLessThan(300);
        const tokenJson = yield* Schema.decodeEffect(UnknownJsonString)(
          new TextDecoder().decode(tokenResponse.body)
        ).pipe(Effect.mapError(() => new TestPromiseFailure()));
        const token = yield* Schema.decodeUnknownEffect(sandboxTokenResponse)(tokenJson).pipe(
          Effect.mapError(() => new TestPromiseFailure())
        );
        const prepared = yield* fromTestPromise(() =>
          handlePaymentEnrollment({
            environment,
            request: fixture.request("/web/subscription/payment-enrollments/prepare", "POST", {
              priceId: scenario.priceId,
              method: "nequi",
            }),
          })
        );
        expect(prepared.status).toBe(200);
        const enrollment = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(PaymentEnrollment))(
          yield* fromTestPromise(() => prepared.json())
        ).pipe(Effect.mapError(() => new TestPromiseFailure()));
        const payload = {
          enrollmentId: enrollment.enrollmentId,
          method: "nequi",
          paymentSourceMode: "create",
          nequiToken: token.data.id,
          paymentRequestId: newId(),
          billingEmail: "payer@example.com",
          decisions: {
            acceptedEndUserPolicy: true,
            acceptedPersonalDataAuthorization: true,
            authorizedRecurringCharges: true,
          },
        };
        let submission = yield* fromTestPromise(() =>
          handlePaymentEnrollment({
            environment,
            request: fixture.request(
              "/web/subscription/payment-enrollments/submit",
              "POST",
              payload
            ),
          })
        );
        for (let poll = 0; poll < 20 && submission.status === 400; poll++) {
          yield* Effect.sleep("3 seconds");
          submission = yield* fromTestPromise(() =>
            handlePaymentEnrollment({
              environment,
              request: fixture.request(
                "/web/subscription/payment-enrollments/submit",
                "POST",
                payload
              ),
            })
          );
        }
        expect(submission.status).toBe(200);
        let submitted = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(PaymentSubmission))(
          yield* fromTestPromise(() => submission.json())
        ).pipe(Effect.mapError(() => new TestPromiseFailure()));
        const continuation = {
          enrollmentId: payload.enrollmentId,
          paymentSourceMode: "reuse",
          paymentRequestId: payload.paymentRequestId,
          billingEmail: payload.billingEmail,
          decisions: payload.decisions,
        };
        payload.nequiToken = "";
        for (let poll = 0; poll < 7 && submitted.status === "source-verifying"; poll++) {
          yield* Effect.sleep("4 seconds");
          const observed = yield* fromTestPromise(() =>
            handlePaymentEnrollment({
              environment,
              request: fixture.request(
                "/web/subscription/payment-enrollments/submit",
                "POST",
                continuation
              ),
            })
          );
          expect(observed.status).toBe(200);
          submitted = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(PaymentSubmission))(
            yield* fromTestPromise(() => observed.json())
          ).pipe(Effect.mapError(() => new TestPromiseFailure()));
        }
        if (submitted.status !== "payment-pending") throw new TestPromiseFailure();
        yield* proveSandboxSettlement({
          environment,
          request: fixture.request,
          attemptId: submitted.billingAttempt.id,
          outcome: scenario.outcome,
        });
      })
    ),
  600_000
);

const withHeader = (request: Request, name: string, value: string): Request => {
  const headers = new Headers(request.headers);
  headers.set(name, value);
  return new Request(request, { headers });
};

const providerBody = (url: URL, status: "PENDING" | "AVAILABLE"): string => {
  if (url.href.includes("/v1/merchants/")) return merchant;
  if (url.href.includes("/v1/payment_sources/3891")) {
    return JSON.stringify({
      data: { id: 3891, type: "CARD", status, customer_email: "payer@example.com" },
    });
  }
  return JSON.stringify({ data: { id: 3891, status } });
};

it("derives the same BillingAttempt and checkout reference for one User action without sharing another User's identity", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const paymentRequestId = "40000000-0000-4000-8000-000000000001";
      const requestId = PaymentRequestId.make(paymentRequestId);
      const first = yield* fromTestPromise(() =>
        billingAttemptIdFor({ userId: UserId.make(userA), requestId })
      );
      const retry = yield* fromTestPromise(() =>
        billingAttemptIdFor({ userId: UserId.make(userA), requestId })
      );
      const otherUser = yield* fromTestPromise(() =>
        billingAttemptIdFor({ userId: UserId.make(userB), requestId })
      );
      expect(retry).toBe(first);
      expect(otherUser).not.toBe(first);
      expect(`fidy-${first}`).toMatch(/^fidy-[0-9a-f-]{36}$/u);
    })
  ));

it("bounds rejected card preparation attempts without invoking Wompi", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, environment, request } = yield* fromTestPromise(() => setup());
      const now = yield* Clock.currentTimeMillis;
      const prior = Array.from({ length: 12 }, (_, index) =>
        db
          .prepare(
            `INSERT INTO card_enrollments
           (id, user_id, price_id, billing_email, status, payment_source_mode,
            contracts_json, disclosure_json, prepared_at_ms, expires_at_ms)
           VALUES (?, ?, ?, 'payer@example.com', 'refused', 'create', '{}', '{}', ?, ?)`
          )
          .bind(
            `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            userA,
            priceId,
            now,
            now + 900_000
          )
      );
      yield* fromTestPromise(() => db.batch(prior));
      const provider = vi.fn(() => Promise.resolve(new Response(merchant)));
      vi.stubGlobal("fetch", provider);
      for (let attempt = 0; attempt < 24; attempt++) {
        const refused = yield* fromTestPromise(() =>
          handlePaymentEnrollment({
            request: request("/web/subscription/payment-enrollments/prepare", "POST", { priceId }),
            environment,
          })
        );
        expect(refused.status).toBe(503);
      }
      const exhausted = yield* fromTestPromise(() =>
        handlePaymentEnrollment({
          request: request("/web/subscription/payment-enrollments/prepare", "POST", { priceId }),
          environment,
        })
      );
      expect(exhausted.status).toBe(429);
      expect(provider).not.toHaveBeenCalled();
      const claims = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT count(*) AS total FROM resource_admission_events WHERE policy_key = 'billing.card-preparation.attempt.user.v1' AND scope_key = ?"
          )
          .bind(userA)
          .first<{ total: number }>()
      );
      expect(claims?.total).toBe(24);
      yield* sweepExpiredEnrollmentAdmission({
        db,
        now: (yield* Clock.currentTimeMillis) + 3_600_001,
      });
      const expired = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT count(*) AS total FROM resource_admission_events WHERE policy_key = 'billing.card-preparation.attempt.user.v1' AND scope_key = ?"
          )
          .bind(userA)
          .first<{ total: number }>()
      );
      expect(expired?.total).toBe(0);
    })
  ));

it("fails closed before card preparation when the admission authority is unavailable", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, environment, request } = yield* fromTestPromise(() => setup());
      const failedDb = new Proxy(db, {
        get: (target, key): unknown =>
          key === "batch"
            ? (): Promise<never> => Promise.reject(new Error("D1 unavailable"))
            : Reflect.get(target, key, target),
      });
      const provider = vi.fn(() => Promise.resolve(new Response(merchant)));
      vi.stubGlobal("fetch", provider);
      const refused = yield* fromTestPromise(() =>
        handlePaymentEnrollment({
          request: request("/web/subscription/payment-enrollments/prepare", "POST", { priceId }),
          environment: { ...environment, DB: failedDb },
        })
      );
      expect(refused.status).toBe(503);
      expect(provider).not.toHaveBeenCalled();
      const rows = yield* fromTestPromise(() =>
        db.prepare("SELECT count(*) AS total FROM card_enrollments").first<{ total: number }>()
      );
      expect(rows?.total).toBe(0);
    })
  ));

it("prepares a Price and creates exactly one provider source and pending BillingAttempt across duplicate submissions", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, environment, request } = yield* fromTestPromise(() => setup());
      const provider = vi.fn((req: URL, _init?: RequestInit): Promise<Response> =>
        Promise.resolve(
          new Response(providerBody(req, "AVAILABLE"), {
            status: _init?.method === "POST" ? 201 : 200,
          })
        )
      );
      vi.stubGlobal("fetch", provider);
      const prepared = yield* fromTestPromise(() =>
        handlePaymentEnrollment({
          request: request("/web/subscription/payment-enrollments/prepare", "POST", { priceId }),
          environment,
        })
      );
      expect(prepared.status).toBe(200);
      const preparedBody: unknown = yield* fromTestPromise(() => prepared.json());
      expect(preparedBody).toMatchObject({
        status: "prepared",
        price: { money: { amount: "9900", currency: "COP" } },
        paymentSourceMode: "create",
      });
      const data = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(PaymentEnrollment))(
        preparedBody
      ).pipe(Effect.orDie);
      if (data.status !== "prepared") throw new Error("expected prepared enrollment");
      const submission = {
        paymentSourceMode: "create",
        enrollmentId: data.enrollmentId,
        paymentRequestId: "30000000-0000-4000-8000-000000000001",
        billingEmail: "payer@example.com",
        decisions: {
          acceptedEndUserPolicy: true,
          acceptedPersonalDataAuthorization: true,
          authorizedRecurringCharges: true,
        },
        cardToken: "tok_test_browser_only",
      };
      const send = (): Promise<Response> =>
        handlePaymentEnrollment({
          request: request("/web/subscription/payment-enrollments/submit", "POST", submission),
          environment,
        });
      const changedEmail = yield* fromTestPromise(() =>
        handlePaymentEnrollment({
          request: request("/web/subscription/payment-enrollments/submit", "POST", {
            ...submission,
            billingEmail: "wrong@example.com",
          }),
          environment,
        })
      );
      expect(changedEmail.status).toBe(400);
      expect(changedEmail.headers.get("cache-control")).toBe("no-store");
      expect(provider.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
      const concurrent = yield* fromTestPromise(() => Promise.all([send(), send()]));
      expect(concurrent.every((response) => response.status === 200)).toBe(true);
      const first = yield* fromTestPromise(() => send());
      const result = yield* fromTestPromise(() => first.json());
      // Worked SHA-256/UUID-v4 vector for this User and PaymentRequestId, independent of the helper.
      const expectedId = "c130318e-2d38-470c-90b0-4f77028b0364";
      expect(result).toMatchObject({
        status: "payment-pending",
        billingAttempt: { id: expectedId, status: "pending", money: { amount: "9900" } },
      });
      const stored = yield* fromTestPromise(() =>
        db
          .prepare(
            "SELECT id, wompi_reference FROM billing_attempts WHERE user_id = ? AND payment_request_id = ?"
          )
          .bind(userA, submission.paymentRequestId)
          .first()
      );
      expect(stored).toMatchObject({ id: expectedId, wompi_reference: `fidy-${expectedId}` });
      expect(
        yield* fromTestPromise(() =>
          db
            .prepare("SELECT state FROM billing_collection_arms WHERE attempt_id = ?")
            .bind(expectedId)
            .first()
        )
      ).toMatchObject({ state: "armed" });
      expect(
        yield* fromTestPromise(() =>
          db
            .prepare("SELECT version FROM billing_collection_outbox WHERE attempt_id = ?")
            .bind(expectedId)
            .first()
        )
      ).toMatchObject({ version: 1 });
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result).pipe(Effect.orDie)
      ).not.toMatch(/3891|tok_test_browser_only|prv_test|fidy-/u);
      const retried = yield* fromTestPromise(() => send());
      expect(retried.status).toBe(200);
      expect(yield* fromTestPromise(() => retried.json())).toMatchObject({
        billingAttempt: { id: expectedId },
      });
      const next = yield* fromTestPromise(() =>
        handlePaymentEnrollment({
          request: request("/web/subscription/payment-enrollments/prepare", "POST", { priceId }),
          environment,
        })
      );
      const second: unknown = yield* fromTestPromise(() => next.json());
      expect(second).toMatchObject({ status: "prepared", paymentSourceMode: "reuse" });
      const secondEnrollment = yield* Schema.decodeUnknownEffect(
        Schema.toCodecJson(PaymentEnrollment)
      )(second).pipe(Effect.orDie);
      if (secondEnrollment.status !== "prepared") throw new Error("expected second preparation");
      expect(
        (yield* fromTestPromise(() =>
          handlePaymentEnrollment({
            request: request("/web/subscription/payment-enrollments/submit", "POST", {
              enrollmentId: secondEnrollment.enrollmentId,
              paymentSourceMode: "reuse",
              paymentRequestId: submission.paymentRequestId,
              billingEmail: submission.billingEmail,
              decisions: submission.decisions,
            }),
            environment,
          })
        )).status
      ).toBe(400);
      const reuse = yield* fromTestPromise(() =>
        handlePaymentEnrollment({
          request: request("/web/subscription/payment-enrollments/submit", "POST", {
            enrollmentId: secondEnrollment.enrollmentId,
            paymentSourceMode: "reuse",
            billingEmail: submission.billingEmail,
            decisions: submission.decisions,
            paymentRequestId: "30000000-0000-4000-8000-000000000002",
          }),
          environment,
        })
      );
      expect(reuse.status).toBe(503);
      expect(provider.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
      expect(
        (yield* fromTestPromise(() => db.prepare("SELECT id FROM billing_attempts").all())).results
      ).toHaveLength(1);
      // Even a failed BillingAttempt cannot release another collection without no-charge evidence.
      const confirmation = (ref: string): Promise<D1Result> =>
        db
          .prepare(`INSERT INTO billing_no_charge_confirmations
        (attempt_id, wompi_reference, wompi_environment, provider_case_id, operator_id, confirmed_at_ms)
        VALUES (?, ?, 'sandbox', 'case-123', 'operator-42', 180002)`)
          .bind(expectedId, ref)
          .run();
      yield* fromTestPromise(() => expect(confirmation(`fidy-${expectedId}`)).rejects.toThrow());
      yield* fromTestPromise(() =>
        db
          .prepare(`UPDATE billing_collection_arms
        SET state = 'sent', sent_at_ms = 1 WHERE attempt_id = ?`)
          .bind(expectedId)
          .run()
      );
      yield* fromTestPromise(() => expect(confirmation("fidy-foreign")).rejects.toThrow());
      yield* fromTestPromise(() =>
        db
          .prepare(`UPDATE billing_attempts SET status = 'failed',
        finalized_at_ms = 180001 WHERE id = ?`)
          .bind(expectedId)
          .run()
      );
      expect(
        (yield* fromTestPromise(() =>
          handlePaymentEnrollment({
            request: request("/web/subscription/payment-enrollments/submit", "POST", {
              enrollmentId: secondEnrollment.enrollmentId,
              paymentSourceMode: "reuse",
              billingEmail: submission.billingEmail,
              decisions: submission.decisions,
              paymentRequestId: "30000000-0000-4000-8000-000000000002",
            }),
            environment,
          })
        )).status
      ).toBe(503);
      yield* fromTestPromise(() => confirmation(`fidy-${expectedId}`));
      const cleared = yield* fromTestPromise(() =>
        handlePaymentEnrollment({
          request: request("/web/subscription/payment-enrollments/submit", "POST", {
            enrollmentId: secondEnrollment.enrollmentId,
            paymentSourceMode: "reuse",
            billingEmail: submission.billingEmail,
            decisions: submission.decisions,
            paymentRequestId: "30000000-0000-4000-8000-000000000002",
          }),
          environment,
        })
      );
      expect(cleared.status).toBe(200);
      expect(yield* fromTestPromise(() => cleared.json())).toMatchObject({
        status: "payment-pending",
      });
      expect(
        (yield* fromTestPromise(() => db.prepare("SELECT id FROM card_payment_sources").all()))
          .results
      ).toHaveLength(1);
      expect(
        (yield* fromTestPromise(() => db.prepare("SELECT id FROM billing_attempts").all())).results
      ).toHaveLength(2);
    })
  ));

it("reserves preparation before calling Wompi and bounds failed preparations", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, environment, request } = yield* fromTestPromise(() => setup());
      const { promise: pending, resolve: release } = Promise.withResolvers<Response>();
      const provider = vi.fn((): Promise<Response> => pending);
      vi.stubGlobal("fetch", provider);
      const prepare = (): Promise<Response> =>
        handlePaymentEnrollment({
          request: request("/web/subscription/payment-enrollments/prepare", "POST", { priceId }),
          environment,
        });
      const first = prepare();
      yield* fromTestPromise(() => vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1)));
      expect((yield* fromTestPromise(() => prepare())).status).toBe(503);
      expect(provider).toHaveBeenCalledTimes(1);
      release(new Response("{}", { status: 400 }));
      expect((yield* fromTestPromise(() => first)).status).toBe(503);
      expect(
        (yield* fromTestPromise(() => db.prepare("SELECT status FROM card_enrollments").first()))
          ?.status
      ).toBe("refused");
      // Other failed reservations consume the same rate-limit window, regardless of provider outcome.
      const now = yield* Clock.currentTimeMillis;
      yield* fromTestPromise(() =>
        db.batch(
          Array.from({ length: 11 }, (_, offset) =>
            db
              .prepare(`INSERT INTO card_enrollments
      (id, user_id, price_id, billing_email, status, payment_source_mode,
       contracts_json, disclosure_json, prepared_at_ms, expires_at_ms)
      VALUES (?, ?, ?, 'payer@example.com', 'refused', 'create', '{}', '{}', ?, ?)`)
              .bind(
                `20000000-0000-4000-8000-${String(offset + 2).padStart(12, "0")}`,
                userA,
                priceId,
                now,
                now + 900_000
              )
          )
        )
      );
      expect((yield* fromTestPromise(() => prepare())).status).toBe(503);
      expect(provider).toHaveBeenCalledTimes(1);
      expect(
        (yield* fromTestPromise(() => db.prepare("SELECT id FROM card_enrollments").all())).results
      ).toHaveLength(12);
    })
  ));

it("rejects a foreign Origin or missing session without provider or persistence effects", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, environment, request } = yield* fromTestPromise(() => setup());
      const provider = vi.fn(() => Promise.resolve(new Response(merchant)));
      vi.stubGlobal("fetch", provider);
      expect(
        (yield* fromTestPromise(() =>
          handlePaymentEnrollment({
            request: withHeader(
              request("/web/subscription/payment-enrollments/prepare", "POST", { priceId }),
              "origin",
              "https://evil.test"
            ),
            environment,
          })
        )).status
      ).toBe(403);
      expect(
        (yield* fromTestPromise(() =>
          handlePaymentEnrollment({
            request: withHeader(
              request("/web/subscription/payment-enrollments/prepare", "POST", { priceId }),
              "cookie",
              "wrong"
            ),
            environment,
          })
        )).status
      ).toBe(401);
      expect(provider).not.toHaveBeenCalled();
      expect(
        (yield* fromTestPromise(() => db.prepare("SELECT id FROM card_enrollments").all())).results
      ).toEqual([]);
    })
  ));

it("never repeats a source POST after a provider timeout without a known candidate", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, environment, request } = yield* fromTestPromise(() => setup());
      const provider = vi.fn((url: URL, init?: RequestInit): Promise<Response> =>
        init?.method === "POST"
          ? Promise.reject(new Error("provider timeout"))
          : Promise.resolve(new Response(providerBody(url, "AVAILABLE"), { status: 200 }))
      );
      vi.stubGlobal("fetch", provider);
      const prepared = yield* fromTestPromise(() =>
        handlePaymentEnrollment({
          request: request("/web/subscription/payment-enrollments/prepare", "POST", { priceId }),
          environment,
        })
      );
      const decoded = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(PaymentEnrollment))(
        yield* fromTestPromise(() => prepared.json())
      ).pipe(Effect.orDie);
      if (decoded.status !== "prepared") throw new Error("expected prepared enrollment");
      const send = (): Promise<Response> =>
        handlePaymentEnrollment({
          request: request("/web/subscription/payment-enrollments/submit", "POST", {
            enrollmentId: decoded.enrollmentId,
            paymentSourceMode: "create",
            cardToken: "tok_test_browser_only",
            paymentRequestId: "30000000-0000-4000-8000-000000000009",
            billingEmail: "payer@example.com",
            decisions: {
              acceptedEndUserPolicy: true,
              acceptedPersonalDataAuthorization: true,
              authorizedRecurringCharges: true,
            },
          }),
          environment,
        });
      const firstSubmission = yield* fromTestPromise(() => send());
      expect(yield* fromTestPromise(() => firstSubmission.json())).toMatchObject({
        status: "source-verifying",
      });
      const secondSubmission = yield* fromTestPromise(() => send());
      expect(yield* fromTestPromise(() => secondSubmission.json())).toMatchObject({
        status: "source-verifying",
      });
      expect(provider.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
      expect(
        (yield* fromTestPromise(() => db.prepare("SELECT id FROM card_payment_sources").all()))
          .results
      ).toHaveLength(0);
      expect(
        (yield* fromTestPromise(() => db.prepare("SELECT id FROM billing_attempts").all())).results
      ).toHaveLength(0);
    })
  ));

it("rejects a cross-Origin public submission before Core delegation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const core = vi.fn(() => Promise.resolve(new Response("must not call")));
      const ingress = makePublicWorker(cloudflareWorkerTelemetry);
      const environment = {
        BROWSER_ORIGIN: browserOrigins.local,
        CORE: { fetch: core },
        LOCAL_CANONICAL_READ_BEARER: localCanonicalReadBearer,
        PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
        RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
      };
      const rejected = yield* fromTestPromise(() =>
        ingress.fetch(
          new Request("https://api.fidyapp.com/web/subscription/payment-enrollments/submit", {
            method: "POST",
            headers: { origin: "https://evil.test" },
            body: "{}",
          }),
          environment
        )
      );
      expect(rejected.status).toBe(403);
      expect(rejected.headers.get("cache-control")).toBe("no-store");
      expect(core).not.toHaveBeenCalled();
    })
  ));

it("resolves a pending provider source by authenticated lookup without another source POST", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, environment, request } = yield* fromTestPromise(() => setup());
      let available = false;
      let mismatched = false;
      const provider = vi.fn((url: URL, init?: RequestInit): Promise<Response> => {
        const body =
          mismatched && url.href.includes("/v1/payment_sources/3891")
            ? JSON.stringify({
                data: { id: 3892, status: "AVAILABLE", customer_email: "payer@example.com" },
              })
            : providerBody(
                url,
                url.href.includes("/v1/payment_sources/3891") && available ? "AVAILABLE" : "PENDING"
              );
        return Promise.resolve(new Response(body, { status: init?.method === "POST" ? 201 : 200 }));
      });
      vi.stubGlobal("fetch", provider);
      const prepared = yield* fromTestPromise(() =>
        handlePaymentEnrollment({
          request: request("/web/subscription/payment-enrollments/prepare", "POST", { priceId }),
          environment,
        })
      );
      const decoded = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(PaymentEnrollment))(
        yield* fromTestPromise(() => prepared.json())
      ).pipe(Effect.orDie);
      if (decoded.status !== "prepared") throw new Error("expected prepared enrollment");
      const payload = {
        enrollmentId: decoded.enrollmentId,
        paymentSourceMode: "create",
        paymentRequestId: "30000000-0000-4000-8000-000000000007",
        billingEmail: "payer@example.com",
        cardToken: "tok_test_browser_only",
        decisions: {
          acceptedEndUserPolicy: true,
          acceptedPersonalDataAuthorization: true,
          authorizedRecurringCharges: true,
        },
      };
      const send = (): Promise<Response> =>
        handlePaymentEnrollment({
          request: request("/web/subscription/payment-enrollments/submit", "POST", payload),
          environment,
        });
      const pendingSubmission = yield* fromTestPromise(() => send());
      expect(yield* fromTestPromise(() => pendingSubmission.json())).toMatchObject({
        status: "source-verifying",
      });
      expect(
        (yield* fromTestPromise(() => db.prepare("SELECT id FROM card_payment_sources").all()))
          .results
      ).toHaveLength(0);
      available = true;
      const lookups = provider.mock.calls.length;
      const burst = yield* fromTestPromise(() => Promise.all([send(), send(), send()]));
      expect(burst.every((response) => response.status === 200)).toBe(true);
      expect(provider.mock.calls).toHaveLength(lookups);
      yield* fromTestPromise(() =>
        db
          .prepare("UPDATE card_enrollments SET last_verification_at_ms = 0 WHERE id = ?")
          .bind(decoded.enrollmentId)
          .run()
      );
      const resume = (): Promise<Response> =>
        handlePaymentEnrollment({
          request: request("/web/subscription/payment-enrollments/submit", "POST", {
            enrollmentId: decoded.enrollmentId,
            paymentSourceMode: "reuse",
            paymentRequestId: payload.paymentRequestId,
            billingEmail: payload.billingEmail,
            decisions: payload.decisions,
          }),
          environment,
        });
      mismatched = true;
      const mismatchedLookup = yield* fromTestPromise(() => resume());
      expect(yield* fromTestPromise(() => mismatchedLookup.json())).toMatchObject({
        status: "source-verifying",
      });
      expect(
        (yield* fromTestPromise(() => db.prepare("SELECT id FROM card_payment_sources").all()))
          .results
      ).toHaveLength(0);
      expect(
        (yield* fromTestPromise(() => db.prepare("SELECT id FROM billing_attempts").all())).results
      ).toHaveLength(0);
      mismatched = false;
      yield* fromTestPromise(() =>
        db
          .prepare("UPDATE card_enrollments SET last_verification_at_ms = 0 WHERE id = ?")
          .bind(decoded.enrollmentId)
          .run()
      );
      const verifiedLookup = yield* fromTestPromise(() => resume());
      expect(yield* fromTestPromise(() => verifiedLookup.json())).toMatchObject({
        status: "payment-pending",
      });
      expect(provider.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
      expect(
        (yield* fromTestPromise(() => db.prepare("SELECT id FROM card_payment_sources").all()))
          .results
      ).toHaveLength(1);
      expect(
        (yield* fromTestPromise(() => db.prepare("SELECT id FROM billing_attempts").all())).results
      ).toHaveLength(1);
    })
  ));
