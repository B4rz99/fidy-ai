import type { Miniflare } from "miniflare";
import { afterEach, expect, it, vi } from "vitest";
import { CardEnrollment, PaymentRequestId } from "@fidy/server/client";
import { UserId } from "@fidy/server/identity-runtime";
import { Clock, Data, Effect, Schema } from "effect";
import { billingAttemptIdFor, handleCardEnrollment } from "./card-enrollment";
import { browserOrigins, localCanonicalReadBearer } from "../runtime/topology";
import { makePublicWorker } from "../public-worker";
import { cloudflareWorkerTelemetry } from "../runtime/telemetry";
import { makeCardEnrollmentD1 } from "./card-enrollment-d1.test-fixture";

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
      const { db, instance } = yield* makeCardEnrollmentD1(name, [
        "CREATE TABLE users (id TEXT PRIMARY KEY, time_zone TEXT NOT NULL) STRICT",
        "CREATE TABLE verified_email_credentials (user_id TEXT PRIMARY KEY, email_address TEXT NOT NULL) STRICT",
        "CREATE TABLE onboarding_consent_records (user_id TEXT PRIMARY KEY) STRICT",
        `CREATE TABLE web_sessions (user_id TEXT NOT NULL, token_digest BLOB NOT NULL,
      revoked_at_ms INTEGER, fresh_until_ms INTEGER NOT NULL, idle_expires_at_ms INTEGER NOT NULL,
      hard_expires_at_ms INTEGER NOT NULL) STRICT`,
      ]);
      instances.push(instance);
      yield* fromTestPromise(() =>
        db
          .prepare("INSERT INTO users VALUES (?, 'America/Bogota'), (?, 'America/Bogota')")
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
          .prepare("INSERT INTO web_sessions VALUES (?, ?, NULL, ?, ?, ?)")
          .bind(userA, digest, now + 600_000, now + 600_000, now + 600_000)
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
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      return { db, environment, request };
    })
  );

const withHeader = (request: Request, name: string, value: string): Request => {
  const headers = new Headers(request.headers);
  headers.set(name, value);
  return new Request(request, { headers });
};

const providerBody = (url: URL, status: "PENDING" | "AVAILABLE"): string => {
  if (url.href.includes("/v1/merchants/")) return merchant;
  if (url.href.includes("/v1/payment_sources/3891")) {
    return JSON.stringify({ data: { id: 3891, status, customer_email: "payer@example.com" } });
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
        handleCardEnrollment({
          request: request("/web/subscription/card-enrollments/prepare", "POST", { priceId }),
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
      const data = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(CardEnrollment))(
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
        handleCardEnrollment({
          request: request("/web/subscription/card-enrollments/submit", "POST", submission),
          environment,
        });
      const changedEmail = yield* fromTestPromise(() =>
        handleCardEnrollment({
          request: request("/web/subscription/card-enrollments/submit", "POST", {
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
        handleCardEnrollment({
          request: request("/web/subscription/card-enrollments/prepare", "POST", { priceId }),
          environment,
        })
      );
      const second: unknown = yield* fromTestPromise(() => next.json());
      expect(second).toMatchObject({ status: "prepared", paymentSourceMode: "reuse" });
      const secondEnrollment = yield* Schema.decodeUnknownEffect(
        Schema.toCodecJson(CardEnrollment)
      )(second).pipe(Effect.orDie);
      if (secondEnrollment.status !== "prepared") throw new Error("expected second preparation");
      expect(
        (yield* fromTestPromise(() =>
          handleCardEnrollment({
            request: request("/web/subscription/card-enrollments/submit", "POST", {
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
        handleCardEnrollment({
          request: request("/web/subscription/card-enrollments/submit", "POST", {
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
          handleCardEnrollment({
            request: request("/web/subscription/card-enrollments/submit", "POST", {
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
        handleCardEnrollment({
          request: request("/web/subscription/card-enrollments/submit", "POST", {
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
        handleCardEnrollment({
          request: request("/web/subscription/card-enrollments/prepare", "POST", { priceId }),
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
          handleCardEnrollment({
            request: withHeader(
              request("/web/subscription/card-enrollments/prepare", "POST", { priceId }),
              "origin",
              "https://evil.test"
            ),
            environment,
          })
        )).status
      ).toBe(403);
      expect(
        (yield* fromTestPromise(() =>
          handleCardEnrollment({
            request: withHeader(
              request("/web/subscription/card-enrollments/prepare", "POST", { priceId }),
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
        handleCardEnrollment({
          request: request("/web/subscription/card-enrollments/prepare", "POST", { priceId }),
          environment,
        })
      );
      const decoded = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(CardEnrollment))(
        yield* fromTestPromise(() => prepared.json())
      ).pipe(Effect.orDie);
      if (decoded.status !== "prepared") throw new Error("expected prepared enrollment");
      const send = (): Promise<Response> =>
        handleCardEnrollment({
          request: request("/web/subscription/card-enrollments/submit", "POST", {
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
          new Request("https://api.fidyapp.com/web/subscription/card-enrollments/submit", {
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
        handleCardEnrollment({
          request: request("/web/subscription/card-enrollments/prepare", "POST", { priceId }),
          environment,
        })
      );
      const decoded = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(CardEnrollment))(
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
        handleCardEnrollment({
          request: request("/web/subscription/card-enrollments/submit", "POST", payload),
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
        handleCardEnrollment({
          request: request("/web/subscription/card-enrollments/submit", "POST", {
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
