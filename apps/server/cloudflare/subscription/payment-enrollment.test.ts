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
import { Cause, Clock, Config, Data, DateTime, Effect, Option, Redacted, Schema } from "effect";
import { billingAttemptIdFor, paymentEnrollmentWork } from "./internal/payment-enrollment";
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
import { executeProtectedSubscriptionQuery } from "./operations";
import { makeCoreHttp } from "../core-http/runtime";
import { SubscriptionEnrollmentGroup } from "../../src/shell/subscription/contract";
import { applyTestMigration } from "../d1-test-fixture";
import { type TransactionSubject } from "../canonical-work/contract";
import {
  loadWompiIntegritySecret,
  loadWompiPrivateKey,
} from "../../src/shell/secret-material/operations";
import {
  DaviplataSandboxProofFailure,
  authorizeDaviplataSandbox,
  requireDaviplataSandboxEnrollment,
  requireDaviplataSandboxPolicy,
} from "./daviplata-sandbox.test-fixture";

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
  subject: TransactionSubject;
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
        "CREATE TABLE trial_periods (user_id TEXT PRIMARY KEY, started_at_ms INTEGER NOT NULL, ends_at_ms INTEGER NOT NULL) STRICT",
        "CREATE TABLE pat_audit (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT, pat_id TEXT, oauth_connection_id TEXT, oauth_credential_id TEXT, operation TEXT NOT NULL, outcome TEXT NOT NULL, occurred_at_ms INTEGER NOT NULL) STRICT",
        "CREATE TABLE pat_atomic_assertion (id INTEGER PRIMARY KEY CHECK (id = 1), accepted INTEGER NOT NULL CHECK (accepted = 1)) STRICT",
        `CREATE TABLE web_sessions (id TEXT NOT NULL, user_id TEXT NOT NULL, token_digest BLOB NOT NULL,
      revoked_at_ms INTEGER, fresh_until_ms INTEGER NOT NULL, idle_expires_at_ms INTEGER NOT NULL,
      hard_expires_at_ms INTEGER NOT NULL) STRICT`,
      ]);
      instances.push(instance);
      yield* fromTestPromise(() =>
        applyTestMigration({
          db,
          source: new URL("../migrations/0016_subscription_standing.sql", import.meta.url),
        })
      );
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
          .prepare("INSERT INTO trial_periods VALUES (?, ?, ?), (?, ?, ?)")
          .bind(userA, now - 604_800_000, now, userB, now - 604_800_000, now)
          .run()
      );
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
      return {
        db,
        environment,
        request,
        subject: { id: "20000000-0000-4000-8000-000000000001", userId: userA, digest },
      };
    })
  );

it.each([
  {
    label: "production not activated",
    market: "production",
    activated: "disabled",
    send: "https://production.wompi.co/otp/send",
    confirm: "https://production.wompi.co/otp/confirm",
  },
  {
    label: "production wrong activation flag",
    market: "production",
    activated: "true",
    send: "https://production.wompi.co/otp/send",
    confirm: "https://production.wompi.co/otp/confirm",
  },
  {
    label: "production missing policy",
    market: "production",
    activated: "enabled",
    send: "",
    confirm: "",
  },
  {
    label: "production with Sandbox destinations",
    market: "production",
    activated: "enabled",
    send: "https://sandbox.wompi.co/otp/send",
    confirm: "https://sandbox.wompi.co/otp/confirm",
  },
  {
    label: "Sandbox missing policy",
    market: "sandbox",
    activated: "enabled",
    send: "",
    confirm: "",
  },
  {
    label: "Sandbox different service origin",
    market: "sandbox",
    activated: "enabled",
    send: "https://unreviewed.example/otp/send",
    confirm: "https://sandbox.wompi.co/otp/confirm",
  },
  {
    label: "Sandbox credential-bearing URL",
    market: "sandbox",
    activated: "enabled",
    send: "https://dummy@sandbox.wompi.co/otp/send",
    confirm: "https://sandbox.wompi.co/otp/confirm",
  },
  {
    label: "Sandbox custom port",
    market: "sandbox",
    activated: "enabled",
    send: "https://sandbox.wompi.co:443/otp/send",
    confirm: "https://sandbox.wompi.co/otp/confirm",
  },
  {
    label: "Sandbox query-bearing URL",
    market: "sandbox",
    activated: "enabled",
    send: "https://sandbox.wompi.co/otp/send?dummy=1",
    confirm: "https://sandbox.wompi.co/otp/confirm",
  },
  {
    label: "Sandbox production confirm destination",
    market: "sandbox",
    activated: "enabled",
    send: "https://sandbox.wompi.co/otp/send",
    confirm: "https://production.wompi.co/otp/confirm",
  },
])("hides and refuses DaviPlata with $label before provider effects", (scenario) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, environment, request } = yield* fromTestPromise(setup);
      const provider = vi.fn(() => Promise.resolve(new Response(merchant)));
      vi.stubGlobal("fetch", provider);
      const production = {
        ...environment,
        WOMPI_ENVIRONMENT: scenario.market,
        WOMPI_PUBLIC_KEY: publicKey.replace(
          "pub_test_",
          `pub_${scenario.market === "sandbox" ? "test" : "prod"}_`
        ),
        WOMPI_PRIVATE_KEY: secret.replace(
          "prv_test_",
          `prv_${scenario.market === "sandbox" ? "test" : "prod"}_`
        ),
        WOMPI_INTEGRITY_SECRET: `${scenario.market === "sandbox" ? "test" : "prod"}_integrity_fixture_key`,
        WOMPI_DAVIPLATA_ACTIVATED: scenario.activated,
        WOMPI_DAVIPLATA_OTP_SEND_URL: scenario.send,
        WOMPI_DAVIPLATA_OTP_CONFIRM_URL: scenario.confirm,
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
  )
);

it("requires Nequi approval before creating a reusable source and collecting one first payment", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, environment, request } = yield* fromTestPromise(setup);
      const { publicFetch } = enrollmentWorkers(environment);
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
      const prepareRequest = request(SubscriptionEnrollmentGroup.endpoints.prepare.path, "POST", {
        priceId,
        method: "nequi",
      });
      prepareRequest.headers.set("authorization", "Bearer not-browser-authority");
      prepareRequest.headers.set("x-untrusted-header", "must-not-cross");
      const preparedResponse = yield* fromTestPromise(() => publicFetch(prepareRequest));
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
        publicFetch(request(SubscriptionEnrollmentGroup.endpoints.submit.path, "POST", payload))
      );
      expect(pending.status).toBe(400);
      expect(sourceCreations).toBe(0);
      approved = true;
      const accepted = yield* fromTestPromise(() =>
        publicFetch(request(SubscriptionEnrollmentGroup.endpoints.submit.path, "POST", payload))
      );
      expect(accepted.status).toBe(200);
      const submitted = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(PaymentSubmission))(
        yield* fromTestPromise(() => accepted.json())
      );
      expect(submitted).toMatchObject({
        status: "payment-pending",
        billingAttempt: { status: "pending" },
      });
      if (submitted.status !== "payment-pending") throw new Error("Missing BillingAttempt");
      const status = yield* fromTestPromise(() =>
        publicFetch(
          request(
            SubscriptionEnrollmentGroup.endpoints.status.path.replace(":enrollmentId", enrollmentId)
          )
        )
      );
      expect(status.status).toBe(200);
      expect(yield* fromTestPromise(() => status.json())).toMatchObject({
        enrollmentId,
        status: "available",
      });
      const attempt = yield* fromTestPromise(() =>
        publicFetch(
          request(
            SubscriptionEnrollmentGroup.endpoints.billingAttempt.path.replace(
              ":billingAttemptId",
              submitted.billingAttempt.id
            )
          )
        )
      );
      expect(attempt.status).toBe(200);
      expect(yield* fromTestPromise(() => attempt.json())).toMatchObject({ status: "pending" });
      const replay = yield* fromTestPromise(() =>
        publicFetch(request(SubscriptionEnrollmentGroup.endpoints.submit.path, "POST", payload))
      );
      expect(replay.status).toBe(200);
      expect(sourceCreations).toBe(1);
      yield* fromTestPromise(() =>
        db.prepare("UPDATE web_sessions SET user_id = ?").bind(userB).run()
      );
      for (const endpoint of [
        SubscriptionEnrollmentGroup.endpoints.status,
        SubscriptionEnrollmentGroup.endpoints.billingAttempt,
      ]) {
        const addressedId =
          endpoint.identifier === "status" ? enrollmentId : submitted.billingAttempt.id;
        const foreign = yield* fromTestPromise(() =>
          publicFetch(request(endpoint.path.replace(/:[^/]+/u, addressedId)))
        );
        expect(foreign.status).toBe(400);
        expect(yield* fromTestPromise(() => foreign.text())).not.toContain(addressedId);
      }
      const foreignSubmit = yield* fromTestPromise(() =>
        publicFetch(request(SubscriptionEnrollmentGroup.endpoints.submit.path, "POST", payload))
      );
      expect(foreignSubmit.status).toBe(400);
      expect(sourceCreations).toBe(1);
      yield* fromTestPromise(() =>
        db.prepare("UPDATE web_sessions SET user_id = ?").bind(userA).run()
      );
      const unchanged = yield* fromTestPromise(() =>
        publicFetch(
          request(
            SubscriptionEnrollmentGroup.endpoints.status.path.replace(":enrollmentId", enrollmentId)
          )
        )
      );
      expect(yield* fromTestPromise(() => unchanged.json())).toMatchObject({
        enrollmentId,
        status: "available",
      });
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

it.each(["sandbox", "production"] as const)(
  "forwards authenticated %s availability through real public and Core routes",
  (market) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* fromTestPromise(setup);
        const provider = vi.fn(() => Promise.resolve(new Response(merchant)));
        vi.stubGlobal("fetch", provider);
        const environment = {
          ...fixture.environment,
          WOMPI_ENVIRONMENT: market,
          WOMPI_PUBLIC_KEY: publicKey.replace(
            "pub_test_",
            market === "sandbox" ? "pub_test_" : "pub_prod_"
          ),
          WOMPI_PRIVATE_KEY: secret.replace(
            "prv_test_",
            market === "sandbox" ? "prv_test_" : "prv_prod_"
          ),
          WOMPI_INTEGRITY_SECRET: `${market === "sandbox" ? "test" : "prod"}_integrity_fixture_key`,
          WOMPI_DAVIPLATA_ACTIVATED: "enabled",
          WOMPI_DAVIPLATA_OTP_SEND_URL: `https://${market}.wompi.co/otp/send`,
          WOMPI_DAVIPLATA_OTP_CONFIRM_URL: `https://${market}.wompi.co/otp/confirm`,
          RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
          CONTRACT_DIGEST: "0".repeat(64),
          USER_TRANSACTION_COORDINATOR: {
            getByName: (): Pick<Fetcher, "fetch"> => ({
              fetch: () => Promise.resolve(new Response(null, { status: 503 })),
            }),
          },
          KAPSO_API_KEY: "fixture-unused",
          KAPSO_WEBHOOK_SECRET: "fixture-unused",
          WHATSAPP_BUSINESS_PORTFOLIO_ID: "fixture-unused",
          CLOUDFLARE_ACCESS_ISSUER: "https://fixture-unused.example",
          CLOUDFLARE_ACCESS_AUDIENCE: "fixture-unused",
        };
        const core = makeCoreHttp(cloudflareWorkerTelemetry);
        const ingress = makePublicWorker(cloudflareWorkerTelemetry);
        const response = yield* fromTestPromise(() =>
          ingress.fetch(
            new Request(
              "https://api.fidyapp.com/web/subscription/payment-enrollments/availability",
              {
                headers: fixture.request("/web/subscription/payment-enrollments/availability")
                  .headers,
              }
            ),
            {
              BROWSER_ORIGIN: browserOrigins.local,
              CORE: {
                fetch: (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
                  core(new Request(input, init), environment),
              },
              LOCAL_CANONICAL_READ_BEARER: localCanonicalReadBearer,
              PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
              RELEASE_GIT_SHA: environment.RELEASE_GIT_SHA,
            }
          )
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("access-control-allow-origin")).toBe(browserOrigins.local);
        expect(yield* fromTestPromise(() => response.json())).toEqual({
          enabledMethods: ["card", "nequi", "daviplata"],
        });
        expect(provider).not.toHaveBeenCalled();
      })
    )
);

const enrollmentWorkers = (
  environment: Awaited<ReturnType<typeof setup>>["environment"]
): Readonly<{
  publicFetch: (request: Request) => Promise<Response>;
  coreFetch: (request: Request) => Promise<Response>;
}> => {
  const core = makeCoreHttp(cloudflareWorkerTelemetry);
  const ingress = makePublicWorker(cloudflareWorkerTelemetry);
  const coreEnvironment = {
    ...environment,
    RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
    CONTRACT_DIGEST: "0".repeat(64),
    USER_TRANSACTION_COORDINATOR: {
      getByName: (): Pick<Fetcher, "fetch"> => ({
        fetch: () => Promise.resolve(new Response(null, { status: 503 })),
      }),
    },
    KAPSO_API_KEY: "fixture-unused",
    KAPSO_WEBHOOK_SECRET: "fixture-unused",
    WHATSAPP_BUSINESS_PORTFOLIO_ID: "fixture-unused",
    CLOUDFLARE_ACCESS_ISSUER: "https://fixture-unused.example",
    CLOUDFLARE_ACCESS_AUDIENCE: "fixture-unused",
  };
  const coreFetch = (request: Request): Promise<Response> => core(request, coreEnvironment);
  return {
    coreFetch,
    publicFetch: (request) =>
      ingress.fetch(request, {
        BROWSER_ORIGIN: browserOrigins.local,
        CORE: {
          fetch: (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const forwarded = new Request(input, init);
            // Forwarding is itself the public/Core protocol under test, not an owner mock.
            expect(forwarded.headers.has("authorization")).toBe(false);
            expect(forwarded.headers.has("x-untrusted-header")).toBe(false);
            expect(forwarded.headers.get("cookie")).toBe(request.headers.get("cookie") ?? "");
            expect(forwarded.headers.get("origin")).toBe(request.headers.get("origin"));
            return coreFetch(forwarded);
          },
        },
        LOCAL_CANONICAL_READ_BEARER: localCanonicalReadBearer,
        PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
        RELEASE_GIT_SHA: coreEnvironment.RELEASE_GIT_SHA,
      }),
  };
};

it.each(Object.values(SubscriptionEnrollmentGroup.endpoints))(
  "keeps $identifier browser-only through public and Core, including method and proof refusals",
  (endpoint) => {
    const body = endpoint.method === "POST" ? { priceId } : undefined;
    return Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* fromTestPromise(setup);
        const workers = enrollmentWorkers(fixture.environment);
        const path = endpoint.path.replace(/:[^/]+/u, "10000000-0000-4000-8000-000000000001");
        const provider = vi.fn(() => Promise.resolve(new Response(merchant)));
        vi.stubGlobal("fetch", provider);
        const preflight = fixture.request(path, "OPTIONS");
        preflight.headers.set("access-control-request-method", endpoint.method);
        preflight.headers.set("access-control-request-headers", "content-type");
        const admitted = yield* fromTestPromise(() => workers.publicFetch(preflight));
        expect(admitted.status).toBe(204);
        expect(admitted.headers.get("access-control-allow-origin")).toBe(browserOrigins.local);
        expect(admitted.headers.get("access-control-allow-credentials")).toBe("true");
        expect(admitted.headers.get("access-control-allow-methods")).toContain(endpoint.method);

        for (const seam of ["publicFetch", "coreFetch"] as const) {
          const wrongMethod = endpoint.method === "GET" ? "POST" : "GET";
          const refusedMethod = yield* fromTestPromise(() =>
            workers[seam](fixture.request(path, wrongMethod))
          );
          expect(refusedMethod.status).toBe(seam === "publicFetch" ? 405 : 400);
          expect(refusedMethod.headers.get("cache-control")).toBe("no-store");
          for (const failure of [
            "missing-origin",
            "foreign-origin",
            "missing-session",
            "PAT-only",
          ]) {
            const request = fixture.request(path, endpoint.method, body);
            removeBrowserProof(request, failure);
            request.headers.set("x-untrusted-header", "must-not-cross");
            const refused = yield* fromTestPromise(() => workers[seam](request));
            expect(refused.status).toBe(failure.endsWith("origin") ? 403 : 401);
            expect(refused.headers.get("cache-control")).toBe("no-store");
          }
          for (const update of [
            "UPDATE web_sessions SET fresh_until_ms = 0",
            "UPDATE web_sessions SET revoked_at_ms = 1",
            "INSERT INTO consent_user_revocations VALUES ('10000000-0000-4000-8000-000000000001')",
          ]) {
            yield* fromTestPromise(() => fixture.db.prepare(update).run());
            const refused = yield* fromTestPromise(() =>
              workers[seam](fixture.request(path, endpoint.method, body))
            );
            expect(refused.status).toBe(401);
            yield* fromTestPromise(() =>
              fixture.db.batch([
                fixture.db.prepare(
                  "UPDATE web_sessions SET fresh_until_ms = hard_expires_at_ms, revoked_at_ms = NULL"
                ),
                fixture.db.prepare("DELETE FROM consent_user_revocations"),
              ])
            );
          }
        }
        expect(provider).not.toHaveBeenCalled();
        for (const table of ["card_enrollments", "card_payment_sources", "billing_attempts"]) {
          expect(
            yield* fromTestPromise(() =>
              fixture.db.prepare(`SELECT count(*) AS count FROM ${table}`).first()
            )
          ).toEqual({ count: 0 });
        }
      })
    );
  }
);

const removeBrowserProof = (request: Request, failure: string): void => {
  if (failure === "missing-origin") {
    request.headers.delete("origin");
  }
  if (failure === "foreign-origin") {
    request.headers.set("origin", "https://foreign.example");
  }
  if (failure === "missing-session" || failure === "PAT-only") {
    request.headers.delete("cookie");
  }
  if (failure === "PAT-only") {
    request.headers.set("authorization", "Bearer pat_fixture_no_browser_authority");
  }
};

it.each([
  "missing-origin",
  "foreign-origin",
  "missing-session",
  "PAT-only",
  "revoked-session",
  "expired-session",
  "withdrawn-consent",
] as const)(
  "refuses availability and DaviPlata preparation with %s before financial effects",
  (failure) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* fromTestPromise(setup);
        const environment = { ...fixture.environment, ...daviplataFixturePolicy };
        const provider = vi.fn(() => Promise.resolve(new Response(merchant)));
        vi.stubGlobal("fetch", provider);
        if (failure === "revoked-session") {
          yield* fromTestPromise(() =>
            fixture.db
              .prepare("UPDATE web_sessions SET revoked_at_ms = 1 WHERE user_id = ?")
              .bind(userA)
              .run()
          );
        }
        if (failure === "expired-session") {
          yield* fromTestPromise(() =>
            fixture.db
              .prepare("UPDATE web_sessions SET fresh_until_ms = 1 WHERE user_id = ?")
              .bind(userA)
              .run()
          );
        }
        if (failure === "withdrawn-consent") {
          yield* fromTestPromise(() =>
            fixture.db.prepare("INSERT INTO consent_user_revocations VALUES (?)").bind(userA).run()
          );
        }
        for (const operation of ["availability", "prepare"]) {
          const request = fixture.request(
            `/web/subscription/payment-enrollments/${operation}`,
            operation === "availability" ? "GET" : "POST",
            operation === "availability" ? undefined : { priceId, method: "daviplata" }
          );
          removeBrowserProof(request, failure);
          const response = yield* fromTestPromise(() =>
            handlePaymentEnrollment({ request, environment })
          );
          expect(response.status).toBe(failure.endsWith("origin") ? 403 : 401);
        }
        expect(provider).not.toHaveBeenCalled();
        expect(
          yield* fromTestPromise(() =>
            fixture.db.prepare("SELECT count(*) AS count FROM card_enrollments").first()
          )
        ).toEqual({ count: 0 });
      })
    )
);

const daviplataFixturePolicy = {
  WOMPI_DAVIPLATA_OTP_SEND_URL: "https://sandbox.wompi.co/daviplata/send",
  WOMPI_DAVIPLATA_OTP_CONFIRM_URL: "https://sandbox.wompi.co/daviplata/confirm",
} as const;

it.each([
  {
    label: "different method",
    type: "NEQUI",
    email: "payer@example.com",
    status: "source-verifying",
  },
  {
    label: "different billing email",
    type: "DAVIPLATA",
    email: "other@example.com",
    status: "refused",
  },
])("does not adopt or bill a DaviPlata source with $label or repeat its creation", (scenario) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* fromTestPromise(setup);
      const environment = { ...fixture.environment, ...daviplataFixturePolicy };
      let matching = false;
      let creations = 0;
      vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname.startsWith("/v1/merchants/")) {
          return Promise.resolve(new Response(merchant));
        }
        if (url.pathname.startsWith("/v1/tokens/daviplata/")) {
          return Promise.resolve(
            Response.json({ data: { id: "daviplata_devtest_verified", status: "APPROVED" } })
          );
        }
        if (init?.method === "POST") {
          creations++;
        }
        return Promise.resolve(
          Response.json({
            data: {
              id: 8276,
              status: "AVAILABLE",
              type: matching ? "DAVIPLATA" : scenario.type,
              customer_email: matching ? "payer@example.com" : scenario.email,
            },
          })
        );
      });
      const preparedResponse = yield* fromTestPromise(() =>
        handlePaymentEnrollment({
          environment,
          request: fixture.request("/web/subscription/payment-enrollments/prepare", "POST", {
            priceId,
            method: "daviplata",
          }),
        })
      );
      expect(preparedResponse.status).toBe(200);
      const prepared = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(PaymentEnrollment))(
        yield* fromTestPromise(() => preparedResponse.json())
      );
      const send = (): Promise<Response> =>
        handlePaymentEnrollment({
          environment,
          request: fixture.request("/web/subscription/payment-enrollments/submit", "POST", {
            enrollmentId: prepared.enrollmentId,
            method: "daviplata",
            paymentSourceMode: "create",
            daviplataToken: "daviplata_devtest_verified",
            paymentRequestId: "40000000-0000-4000-8000-000000000093",
            billingEmail: "payer@example.com",
            decisions: {
              acceptedEndUserPolicy: true,
              acceptedPersonalDataAuthorization: true,
              authorizedRecurringCharges: true,
            },
          }),
        });
      const unadopted = yield* fromTestPromise(send);
      expect(yield* fromTestPromise(() => unadopted.json())).toMatchObject({
        status: scenario.status,
        enrollmentId: prepared.enrollmentId,
      });
      expect(
        yield* fromTestPromise(() =>
          fixture.db.prepare("SELECT count(*) AS count FROM card_payment_sources").first()
        )
      ).toEqual({ count: 0 });
      expect(
        yield* fromTestPromise(() =>
          fixture.db.prepare("SELECT count(*) AS count FROM billing_attempts").first()
        )
      ).toEqual({ count: 0 });
      if (scenario.status === "source-verifying") {
        matching = true;
        yield* Effect.sleep("4 seconds");
        const adopted = yield* fromTestPromise(send);
        expect(yield* fromTestPromise(() => adopted.json())).toMatchObject({
          status: "payment-pending",
          billingAttempt: { status: "pending" },
        });
      } else {
        matching = true;
        const refused = yield* fromTestPromise(send);
        expect(yield* fromTestPromise(() => refused.json())).toMatchObject({
          status: "refused",
          reason: "provider-error",
        });
      }
      expect(creations).toBe(1);
    })
  )
);

const forbiddenDaviplataSubmissions = {
  "document-values": { documentNumber: "document-only-wompi" },
  "product-values": { productNumber: "product-only-wompi" },
  "OTP-values": { otp: "otp-only-wompi" },
  "other-environment": { daviplataToken: "daviplata_prod_disallowed" },
  "disabled-policy": {},
} as const;

it.each(Object.entries(forbiddenDaviplataSubmissions))(
  "refuses DaviPlata submission with %s without claiming authorization or creating a source",
  (failure, fields) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* fromTestPromise(setup);
        const preparedEnvironment = { ...fixture.environment, ...daviplataFixturePolicy };
        const provider = vi.fn(() => Promise.resolve(new Response(merchant)));
        vi.stubGlobal("fetch", provider);
        const preparedResponse = yield* fromTestPromise(() =>
          handlePaymentEnrollment({
            environment: preparedEnvironment,
            request: fixture.request("/web/subscription/payment-enrollments/prepare", "POST", {
              priceId,
              method: "daviplata",
            }),
          })
        );
        expect(preparedResponse.status).toBe(200);
        const prepared = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(PaymentEnrollment))(
          yield* fromTestPromise(() => preparedResponse.json())
        );
        const originalRequests = provider.mock.calls.length;
        const environment =
          failure === "disabled-policy"
            ? { ...preparedEnvironment, WOMPI_DAVIPLATA_OTP_CONFIRM_URL: "" }
            : preparedEnvironment;
        const response = yield* fromTestPromise(() =>
          handlePaymentEnrollment({
            environment,
            request: fixture.request("/web/subscription/payment-enrollments/submit", "POST", {
              enrollmentId: prepared.enrollmentId,
              method: "daviplata",
              paymentSourceMode: "create",
              daviplataToken: "daviplata_devtest_once",
              paymentRequestId: "40000000-0000-4000-8000-000000000091",
              billingEmail: "payer@example.com",
              decisions: {
                acceptedEndUserPolicy: true,
                acceptedPersonalDataAuthorization: true,
                authorizedRecurringCharges: true,
              },
              ...fields,
            }),
          })
        );
        expect(response.status).toBe(failure === "disabled-policy" ? 503 : 400);
        expect(provider.mock.calls).toHaveLength(originalRequests);
        expect(
          yield* fromTestPromise(() =>
            fixture.db
              .prepare(
                "SELECT status, authorization_digest, payment_request_id FROM card_enrollments"
              )
              .first()
          )
        ).toEqual({ status: "prepared", authorization_digest: null, payment_request_id: null });
        expect(
          yield* fromTestPromise(() =>
            fixture.db.prepare("SELECT count(*) AS count FROM card_payment_sources").first()
          )
        ).toEqual({ count: 0 });
        expect(
          yield* fromTestPromise(() =>
            fixture.db.prepare("SELECT count(*) AS count FROM billing_attempts").first()
          )
        ).toEqual({ count: 0 });
      })
    )
);

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
        const beforeSettlement = yield* executeProtectedSubscriptionQuery({
          db: environment.DB,
          subject: fixture.subject,
          operation: "subscription.getSubscriptionStatus",
        });
        expect(yield* fromTestPromise(() => beforeSettlement.json())).toMatchObject({
          data: { accessTier: "free", paidSubscription: null },
        });
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
        const afterSettlement = yield* executeProtectedSubscriptionQuery({
          db: environment.DB,
          subject: fixture.subject,
          operation: "subscription.getSubscriptionStatus",
        });
        expect(yield* fromTestPromise(() => afterSettlement.json())).toMatchObject({
          data: { accessTier: "pro", paidSubscription: { billingPeriod: scenario.period } },
        });
        const otherUser = yield* executeProtectedSubscriptionQuery({
          db: environment.DB,
          subject: { ...fixture.subject, userId: userB },
          operation: "subscription.getSubscriptionStatus",
        });
        expect(otherUser.status).toBe(401);
        const retained = yield* fromTestPromise(() =>
          environment.DB.batch([
            environment.DB.prepare("SELECT * FROM card_enrollments"),
            environment.DB.prepare("SELECT * FROM card_payment_sources"),
            environment.DB.prepare("SELECT * FROM billing_attempts"),
            environment.DB.prepare("SELECT * FROM pat_audit"),
          ])
        );
        const retainedText = yield* Schema.encodeEffect(UnknownJsonString)(retained);
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

// Opt-in real provider proof. Neither provider bodies nor failed live projections enter assertions.
it
  .runIf(
    Effect.runSync(Config.String("FIDY_DAVIPLATA_SANDBOX").pipe(Config.withDefault("0"))) === "1"
  )
  .each(sandboxCases)(
  "proves Sandbox DaviPlata $period first payment with $outcome outcome",
  (scenario) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* Effect.all({
          environment: Config.String("WOMPI_ENVIRONMENT"),
          publicKey: Config.schema(
            Schema.String.check(Schema.isPattern(/^pub_test_[A-Za-z0-9_-]{8,}$/u)),
            "WOMPI_PUBLIC_KEY"
          ),
          privateKey: loadWompiPrivateKey("sandbox"),
          integritySecret: loadWompiIntegritySecret("sandbox"),
          sendUrl: Config.String("WOMPI_DAVIPLATA_OTP_SEND_URL").pipe(Config.option),
          confirmUrl: Config.String("WOMPI_DAVIPLATA_OTP_CONFIRM_URL").pipe(Config.option),
        }).pipe(Effect.mapError(() => new DaviplataSandboxProofFailure()));
        const policy = yield* requireDaviplataSandboxPolicy(provider);
        const fixture = yield* fromTestPromise(setup);
        const environment = {
          ...fixture.environment,
          WOMPI_ENVIRONMENT: "sandbox" as const,
          WOMPI_PUBLIC_KEY: provider.publicKey,
          WOMPI_PRIVATE_KEY: Redacted.value(provider.privateKey),
          WOMPI_INTEGRITY_SECRET: Redacted.value(provider.integritySecret),
          WOMPI_DAVIPLATA_OTP_SEND_URL: policy.sendUrl,
          WOMPI_DAVIPLATA_OTP_CONFIRM_URL: policy.confirmUrl,
        };
        const outbound = yield* wompiOutboundHttp(environment);
        const prepared = yield* fromTestPromise(() =>
          handlePaymentEnrollment({
            environment,
            request: fixture.request("/web/subscription/payment-enrollments/prepare", "POST", {
              priceId: scenario.priceId,
              method: "daviplata",
            }),
          })
        );
        if (prepared.status !== 200) return yield* new DaviplataSandboxProofFailure();
        const enrollment = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(PaymentEnrollment))(
          yield* fromTestPromise(() => prepared.json())
        ).pipe(Effect.mapError(() => new DaviplataSandboxProofFailure()));
        yield* requireDaviplataSandboxEnrollment({ enrollment, policy });
        const authorization = yield* authorizeDaviplataSandbox({
          outbound,
          policy,
          outcome: scenario.outcome,
        });
        const paymentRequestId = newId();
        const decisions = {
          acceptedEndUserPolicy: true,
          acceptedPersonalDataAuthorization: true,
          authorizedRecurringCharges: true,
        };
        const response = yield* fromTestPromise(() =>
          handlePaymentEnrollment({
            environment,
            request: fixture.request("/web/subscription/payment-enrollments/submit", "POST", {
              enrollmentId: enrollment.enrollmentId,
              method: "daviplata",
              paymentSourceMode: "create",
              daviplataToken: Redacted.value(authorization),
              paymentRequestId,
              billingEmail: "payer@example.com",
              decisions,
            }),
          })
        );
        if (response.status !== 200) return yield* new DaviplataSandboxProofFailure();
        let submitted = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(PaymentSubmission))(
          yield* fromTestPromise(() => response.json())
        ).pipe(Effect.mapError(() => new DaviplataSandboxProofFailure()));
        // This continuation observes the existing source; it cannot replay tokenization or source POST.
        for (let poll = 0; poll < 7 && submitted.status === "source-verifying"; poll++) {
          yield* Effect.sleep("4 seconds");
          const observed = yield* fromTestPromise(() =>
            handlePaymentEnrollment({
              environment,
              request: fixture.request("/web/subscription/payment-enrollments/submit", "POST", {
                enrollmentId: enrollment.enrollmentId,
                paymentSourceMode: "reuse",
                paymentRequestId,
                billingEmail: "payer@example.com",
                decisions,
              }),
            })
          );
          if (observed.status !== 200) return yield* new DaviplataSandboxProofFailure();
          submitted = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(PaymentSubmission))(
            yield* fromTestPromise(() => observed.json())
          ).pipe(Effect.mapError(() => new DaviplataSandboxProofFailure()));
        }
        if (submitted.status !== "payment-pending") {
          return yield* new DaviplataSandboxProofFailure();
        }
        yield* proveSandboxSettlement({
          environment,
          request: fixture.request,
          attemptId: submitted.billingAttempt.id,
          outcome: scenario.outcome,
        });
      }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          () => Effect.fail(new DaviplataSandboxProofFailure())
        )
      )
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

it.each([8_640_000_000_000_001, 1_800_000_000_000.5])(
  "refuses retained expiry %s before source creation or billing",
  (expiry) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db, environment, request } = yield* fromTestPromise(setup);
        const provider = vi.fn((url: URL) =>
          Promise.resolve(new Response(providerBody(url, "AVAILABLE")))
        );
        vi.stubGlobal("fetch", provider);
        const prepared = yield* fromTestPromise(() =>
          handlePaymentEnrollment({
            request: request("/web/subscription/payment-enrollments/prepare", "POST", { priceId }),
            environment,
          })
        );
        const data = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(PaymentEnrollment))(
          yield* fromTestPromise(() => prepared.json())
        );
        // Model a hostile D1 projection without weakening production persistence constraints.
        const corruptDb = new Proxy(db, {
          get: (target, key): unknown =>
            key === "prepare"
              ? (sql: string): D1PreparedStatement => {
                  const statement = target.prepare(sql);
                  if (!sql.startsWith("SELECT * FROM card_enrollments")) return statement;
                  const wrap = (bound: D1PreparedStatement): D1PreparedStatement =>
                    new Proxy(bound, {
                      get: (query, member): unknown => {
                        if (member === "bind") {
                          return (...values: Array<unknown>) => wrap(query.bind(...values));
                        }
                        if (member === "first") {
                          return () =>
                            query.first().then((row) => ({ ...row, expires_at_ms: expiry }));
                        }
                        return Reflect.get(query, member, query);
                      },
                    });
                  return wrap(statement);
                }
              : Reflect.get(target, key, target),
        });
        provider.mockClear();
        const response = yield* fromTestPromise(() =>
          handlePaymentEnrollment({
            environment: { ...environment, DB: corruptDb },
            request: request("/web/subscription/payment-enrollments/submit", "POST", {
              enrollmentId: data.enrollmentId,
              paymentSourceMode: "create",
              cardToken: "tok_test_browser_only",
              paymentRequestId: "30000000-0000-4000-8000-000000000099",
              billingEmail: "payer@example.com",
              decisions: {
                acceptedEndUserPolicy: true,
                acceptedPersonalDataAuthorization: true,
                authorizedRecurringCharges: true,
              },
            }),
          })
        );
        expect(response.status).toBe(400);
        const status = yield* fromTestPromise(() =>
          handlePaymentEnrollment({
            environment: { ...environment, DB: corruptDb },
            request: request(`/web/subscription/payment-enrollments/${data.enrollmentId}`),
          })
        );
        expect(status.status).toBe(400);
        const repeatedPreparation = yield* fromTestPromise(() =>
          handlePaymentEnrollment({
            environment: { ...environment, DB: corruptDb },
            request: request("/web/subscription/payment-enrollments/prepare", "POST", { priceId }),
          })
        );
        expect(repeatedPreparation.status).toBe(503);
        expect(provider).not.toHaveBeenCalled();
        expect(
          yield* fromTestPromise(() => db.prepare("SELECT status FROM card_enrollments").first())
        ).toEqual({ status: "prepared" });
        for (const table of [
          "card_payment_sources",
          "billing_attempts",
          "billing_collection_outbox",
        ]) {
          expect(
            yield* fromTestPromise(() =>
              db.prepare(`SELECT count(*) AS count FROM ${table}`).first()
            )
          ).toEqual({ count: 0 });
        }
      })
    )
);

it("inherits the workflow Clock through source authorization and live settlement", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db, environment, request } = yield* fromTestPromise(setup);
      const current = (yield* Clock.currentTimeMillis) - 3_600_000;
      yield* fromTestPromise(() =>
        db
          .prepare(
            "UPDATE web_sessions SET fresh_until_ms = ?, idle_expires_at_ms = ?, hard_expires_at_ms = ?"
          )
          .bind(current + 600_000, current + 600_000, current + 600_000)
          .run()
      );
      const liveClock = yield* Clock.Clock;
      const clock = new Proxy(liveClock, {
        get: (target, key): unknown => {
          if (key === "currentTimeMillis") return Effect.succeed(current);
          if (key === "currentTimeMillisUnsafe") return () => current;
          return Reflect.get(target, key, target);
        },
      });
      const provider = vi.fn((url: URL) =>
        Promise.resolve(new Response(providerBody(url, "AVAILABLE")))
      );
      vi.stubGlobal("fetch", provider);
      const prepared = yield* paymentEnrollmentWork({
        environment,
        request: request("/web/subscription/payment-enrollments/prepare", "POST", { priceId }),
      }).pipe(Effect.provideService(Clock.Clock, clock));
      expect(prepared.status).toBe(200);
      const data = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(PaymentEnrollment))(
        yield* fromTestPromise(() => prepared.json())
      );
      const submitted = yield* paymentEnrollmentWork({
        environment,
        request: request("/web/subscription/payment-enrollments/submit", "POST", {
          enrollmentId: data.enrollmentId,
          paymentSourceMode: "create",
          cardToken: "tok_test_browser_only",
          paymentRequestId: "30000000-0000-4000-8000-000000000097",
          billingEmail: "payer@example.com",
          decisions: {
            acceptedEndUserPolicy: true,
            acceptedPersonalDataAuthorization: true,
            authorizedRecurringCharges: true,
          },
        }),
      }).pipe(Effect.provideService(Clock.Clock, clock));
      expect(submitted.status).toBe(200);
      expect(yield* fromTestPromise(() => submitted.json())).toMatchObject({
        status: "payment-pending",
      });
      expect(
        yield* fromTestPromise(() =>
          db.prepare("SELECT accepted_at_ms FROM card_enrollments").first()
        )
      ).toEqual({ accepted_at_ms: current });
      expect(
        yield* fromTestPromise(() =>
          db.prepare("SELECT count(*) AS count FROM billing_collection_outbox").first()
        )
      ).toEqual({ count: 1 });
    })
  ));

it("cancels an unfinished enrollment body without reserving provider work", () => {
  // The native Request is cancelled independently of the test's Effect fiber.
  const controller = new AbortController();
  return Effect.runPromise(
    Effect.gen(function* () {
      const { db, environment, request } = yield* fromTestPromise(setup);
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        cancel: (): void => {
          cancelled = true;
        },
      });
      const provider = vi.fn(() => Promise.resolve(new Response(merchant)));
      vi.stubGlobal("fetch", provider);
      const input = new Request(request("/web/subscription/payment-enrollments/prepare", "POST"), {
        method: "POST",
        body,
        signal: controller.signal,
      });
      const pending = handlePaymentEnrollment({ request: input, environment });
      yield* fromTestPromise(() => vi.waitFor(() => expect(input.body?.locked).toBe(true)));
      controller.abort();
      expect((yield* fromTestPromise(() => pending)).status).toBe(503);
      expect(cancelled).toBe(true);
      expect(provider).not.toHaveBeenCalled();
      expect(
        yield* fromTestPromise(() =>
          db.prepare("SELECT count(*) AS count FROM card_enrollments").first()
        )
      ).toEqual({ count: 0 });
    })
  );
});

it.each(["contracts", "source", "commit"] as const)(
  "cancels enrollment at %s without detached continuation or replaying a source POST",
  (stage) => {
    // Drive the native ingress signal, not interruption of the test's own Effect fiber.
    const controller = new AbortController();
    return Effect.runPromise(
      Effect.gen(function* () {
        const { db, environment, request } = yield* fromTestPromise(setup);
        const started = Promise.withResolvers<void>();
        const released = Promise.withResolvers<void>();
        const onAccepted = vi.fn();
        let merchantCalls = 0;
        let posts = 0;
        let providerAborted = false;
        const assertProviderAborted = (): void => {
          expect(providerAborted).toBe(true);
        };
        vi.stubGlobal(
          "fetch",
          (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const req = new Request(input, init);
            if (req.url.includes("/merchants/")) merchantCalls++;
            if (req.method === "POST") posts++;
            const blocked =
              (stage === "contracts" && merchantCalls === 2 && req.url.includes("/merchants/")) ||
              (stage === "source" && req.url.includes("/payment_sources/3891"));
            const response = (): Response =>
              new Response(providerBody(new URL(req.url), "AVAILABLE"));
            if (!blocked) return Promise.resolve(response());
            started.resolve();
            // Native fetch must return a Promise; the fixture owns its settlement gate.
            const pending = Promise.withResolvers<Response>();
            req.signal.addEventListener(
              "abort",
              () => {
                providerAborted = true;
                pending.reject(new Error("provider request interrupted"));
              },
              { once: true }
            );
            released.promise.then(() => pending.resolve(response()), pending.reject);
            return pending.promise;
          }
        );
        const prepared = yield* fromTestPromise(() =>
          handlePaymentEnrollment({
            request: request("/web/subscription/payment-enrollments/prepare", "POST", { priceId }),
            environment,
          })
        );
        const data = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(PaymentEnrollment))(
          yield* fromTestPromise(() => prepared.json())
        );
        const delayedDb = new Proxy(db, {
          get: (target, key): unknown =>
            key === "batch" && stage === "commit"
              ? (statements: Array<D1PreparedStatement>) => {
                  const result = target.batch(statements);
                  started.resolve();
                  return result.then((committed) => released.promise.then(() => committed));
                }
              : Reflect.get(target, key, target),
        });
        const payload = {
          enrollmentId: data.enrollmentId,
          paymentSourceMode: "create",
          cardToken: "tok_test_browser_only",
          paymentRequestId: "30000000-0000-4000-8000-000000000098",
          billingEmail: "payer@example.com",
          decisions: {
            acceptedEndUserPolicy: true,
            acceptedPersonalDataAuthorization: true,
            authorizedRecurringCharges: true,
          },
        };
        let settled = false;
        const pending = handlePaymentEnrollment({
          environment: { ...environment, DB: delayedDb, onAccepted },
          request: new Request(
            request("/web/subscription/payment-enrollments/submit", "POST", payload),
            {
              signal: controller.signal,
            }
          ),
        }).then((response) => {
          settled = true;
          return response;
        });
        yield* Effect.gen(function* () {
          yield* fromTestPromise(() => started.promise);
          controller.abort();
          if (stage === "commit") {
            yield* Effect.sleep("20 millis");
            expect(settled).toBe(false);
            expect(onAccepted).not.toHaveBeenCalled();
          } else {
            yield* fromTestPromise(() => vi.waitFor(assertProviderAborted));
          }
        }).pipe(Effect.ensuring(Effect.sync(() => released.resolve())));
        expect((yield* fromTestPromise(() => pending)).status).toBe(503);
        expect(onAccepted).toHaveBeenCalledTimes(stage === "commit" ? 1 : 0);
        expect(
          yield* fromTestPromise(() =>
            db.prepare("SELECT count(*) AS count FROM billing_attempts").first()
          )
        ).toEqual({ count: stage === "commit" ? 1 : 0 });
        expect(
          yield* fromTestPromise(() =>
            db.prepare("SELECT count(*) AS count FROM card_payment_sources").first()
          )
        ).toEqual({ count: stage === "commit" ? 1 : 0 });
        const replay = yield* fromTestPromise(() =>
          handlePaymentEnrollment({
            environment,
            request: request("/web/subscription/payment-enrollments/submit", "POST", payload),
          })
        );
        expect(replay.status).toBe(200);
        expect(posts).toBe(stage === "contracts" ? 0 : 1);
      })
    );
  }
);

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
