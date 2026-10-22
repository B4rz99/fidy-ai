import { type Cause, Clock, Effect, Exit, Schema } from "effect";
import { RefundSupportAdmission, type RefundSupportEnvironment } from "./contract";
import { afterEach, expect, it, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { makePaymentEnrollmentD1 } from "./payment-enrollment-d1.test-fixture";
import { seedRefundCharge } from "./refund-charge.test-fixture";
import { startRefund } from "./operations";
import { approvedWorkersAiModel } from "../../src/shell/hosted-inference/contract";
import coreWorker from "../core-worker";
import publicWorker from "../public-worker";
import { handleRefundSupport } from "./runtime";

let counter = 0;
afterEach(() => {
  vi.unstubAllGlobals();
});
const setup = Effect.fnUntraced(function* () {
  const number = ++counter;
  const made = yield* makePaymentEnrollmentD1([
    "CREATE TABLE users (paid_attempt_id TEXT,paid_price_id TEXT,paid_period_ends_at_ms INTEGER,paid_renewal_anchor_ms INTEGER,id TEXT PRIMARY KEY, time_zone TEXT NOT NULL ,service_market TEXT,locale TEXT,created_at_ms INTEGER,whatsapp_portfolio_id TEXT,whatsapp_bsuid TEXT,whatsapp_verified_at_ms INTEGER,route_portfolio_id TEXT,route_bsuid TEXT,route_phone_number_id TEXT,route_verified_at_ms INTEGER) STRICT",
  ]);

  const keys = yield* Effect.tryPromise(() => generateKeyPair("RS256", { extractable: true }));
  const jwk = yield* Effect.tryPromise(() => exportJWK(keys.publicKey));
  const issuer = `https://refund-support-${number}.cloudflareaccess.com`;
  const admissions: unknown[] = [];
  const services = yield* Effect.context<never>();
  const signingKeys = { keys: [{ ...jwk, kid: "billing-test", alg: "RS256", use: "sig" }] };
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    expect(request.url).toBe(`${issuer}/cdn-cgi/access/certs`);
    expect(request.headers.has("cf-access-jwt-assertion")).toBe(false);
    expect(request.headers.has("authorization")).toBe(false);
    expect(request.headers.has("traceparent")).toBe(false);
    return Promise.resolve(Response.json(signingKeys));
  });
  const environment = {
    DB: made.db,
    WOMPI_ENVIRONMENT: "sandbox",
    CLOUDFLARE_ACCESS_ISSUER: issuer,
    CLOUDFLARE_ACCESS_AUDIENCE: "recovery-permission",
    BILLING_SUPPORT_AUDIENCE: "refund-permission",
    USER_TRANSACTION_COORDINATOR: {
      getByName: (name: string): Pick<Fetcher, "fetch"> => ({
        fetch: (request: RequestInfo | URL): Promise<Response> =>
          Effect.runPromiseWith(services)(
            Effect.gen(function* () {
              const candidate = yield* Effect.tryPromise(() => new Request(request).json());
              const admission =
                yield* Schema.decodeUnknownEffect(RefundSupportAdmission)(candidate);
              expect(admission.input.userId).toBe(name);
              admissions.push(admission);
              return Response.json({ data: { status: "pending" } }, { status: 202 });
            })
          ),
      }),
    },
  };
  const token = (
    audience: string,
    expires = "5m",
    claims: Readonly<Record<string, string>> = {}
  ): Promise<string> =>
    new SignJWT({ email: "support@example.com", ...claims })
      .setSubject("support-operator")
      .setProtectedHeader({ alg: "RS256", kid: "billing-test" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(expires)
      .sign(keys.privateKey);
  return { environment, token, admissions, signingKeys };
});
const publicSupport = (
  request: Request,
  environment: RefundSupportEnvironment
): Promise<Response> =>
  publicWorker.fetch(request, {
    BROWSER_ORIGIN: "https://app.fidyapp.com",
    LOCAL_CANONICAL_READ_BEARER: "",
    PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
    RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
    CORE: {
      fetch: (forwarded, init) =>
        coreWorker.fetch(new Request(forwarded, init), {
          ...environment,
          AI: { run: () => Promise.reject(new Error("unused")) },
          HOSTED_AI_MODEL: approvedWorkersAiModel,
          RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
          CONTRACT_DIGEST: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          BROWSER_ORIGIN: "https://app.fidyapp.com",
          WOMPI_PUBLIC_KEY: "",
          WOMPI_PRIVATE_KEY: "",
          WOMPI_INTEGRITY_SECRET: "",
          KAPSO_API_KEY: "",
          WHATSAPP_SANDBOX_PHONE_NUMBER_ID: "",
          KAPSO_WEBHOOK_SECRET: "",
          WHATSAPP_BUSINESS_PORTFOLIO_ID: "",
        }),
    },
  });
const request = (
  assertion: string,
  body: string = Schema.encodeSync(Schema.fromJsonString(RefundSupportAdmission.fields.input))({
    userId: "10000000-0000-4000-8000-000000000001",
    billingAttemptId: "40000000-0000-4000-8000-000000000001",
    requestId: "50000000-0000-4000-8000-000000000001",
    intent: { kind: "refund", money: { amount: "4000", currency: "COP" } },
    reason: "user-request",
  })
): Request =>
  new Request("https://api.fidyapp.com/internal/support/billing-refunds", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-access-jwt-assertion": assertion },
    body,
  });
it("requires the separate origin-verified refund permission and retains only attributable support evidence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const prepared = yield* setup();
      const assertion = yield* Effect.tryPromise(() => prepared.token("refund-permission"));
      const response = yield* Effect.tryPromise(() =>
        handleRefundSupport({ request: request(assertion), environment: prepared.environment })
      );
      expect(response.status).toBe(202);
      expect(prepared.admissions).toMatchObject([
        { authority: { operatorId: "support-operator", permission: "billing.refund" } },
      ]);
    })
  ));
it.each(["missing", "recovery-audience", "expired", "service-token", "tampered"])(
  "refuses %s before User coordination or accepting refund work",
  (scenario) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const prepared = yield* setup();
        const audience =
          scenario === "recovery-audience" ? "recovery-permission" : "refund-permission";
        const signed = yield* Effect.tryPromise(() =>
          prepared.token(
            audience,
            scenario === "expired" ? "-1m" : "5m",
            scenario === "service-token" ? { common_name: "service-token" } : {}
          )
        );
        let assertion = signed;
        if (scenario === "missing") assertion = "";
        if (scenario === "tampered") {
          assertion = signed.replace(
            /\.([^.])([^.]+)$/u,
            (_match: string, initial: string, rest: string) =>
              `.${initial === "a" ? "b" : "a"}${rest}`
          );
        }
        const response = yield* Effect.tryPromise(() =>
          handleRefundSupport({ request: request(assertion), environment: prepared.environment })
        );
        expect(response.status).toBe(401);
        expect(prepared.admissions).toEqual([]);
      })
    )
);

it.each([
  "zero",
  "negative",
  "excessive-precision",
  "invalid-identity",
  "oversized",
  "malformed-json",
])("refuses authorized %s input through Public and Core without financial effects", (scenario) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const prepared = yield* setup();
      const assertion = yield* Effect.tryPromise(() => prepared.token("refund-permission"));
      let amount = "4000";
      if (scenario === "zero") amount = "0";
      if (scenario === "negative") amount = "-1";
      if (scenario === "excessive-precision") amount = "0.001";
      let body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        userId: "10000000-0000-4000-8000-000000000001",
        billingAttemptId:
          scenario === "invalid-identity"
            ? "not-an-identity"
            : "40000000-0000-4000-8000-000000000001",
        requestId: "50000000-0000-4000-8000-000000000001",
        intent: { kind: "refund", money: { amount, currency: "COP" } },
        reason: "user-request",
      });
      if (scenario === "oversized") body = " ".repeat(4097) + body;
      if (scenario === "malformed-json") body = "{";
      const response = yield* Effect.tryPromise(() =>
        publicSupport(request(assertion, body), prepared.environment)
      );
      expect(response.status).toBe(400);
      expect(yield* Effect.tryPromise(() => response.json())).toEqual({
        error: { code: "invalid-request" },
      });
      expect(prepared.admissions).toEqual([]);
      const retained = yield* Effect.tryPromise(() =>
        prepared.environment.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM refund_attempts) AS attempts,
    (SELECT COUNT(*) FROM (SELECT rowid,id AS refund_id,1 AS version,dispatch_last_attempt_at_ms AS last_attempt_at_ms,published_at_ms,verification_attempts,last_verification_at_ms FROM refund_attempts WHERE verification_attempts IS NOT NULL) AS refund_outbox) AS outbox,
    (SELECT COUNT(*) FROM (SELECT rowid,id AS refund_id,submission_claimed_at_ms AS claimed_at_ms FROM refund_attempts WHERE submission_claimed_at_ms IS NOT NULL) AS refund_submission_claims) AS claims,
    (SELECT COUNT(*) FROM (SELECT rowid,id AS refund_id,provider_refund_id AS provider_id,verified_status,observed_at_ms FROM refund_attempts WHERE verified_status IS NOT NULL) AS refund_outcome_evidence) AS outcomes,
    (SELECT COUNT(*) FROM (SELECT rowid,id AS refund_id,adjusted_attempt_id AS attempt_id,access_ends_at_ms AS ends_at_ms FROM refund_attempts WHERE adjusted_attempt_id IS NOT NULL) AS billing_access_adjustments) AS adjustments,
    (SELECT COUNT(*) FROM (SELECT rowid,id AS refund_id,renewal_stopped_user_id AS user_id,renewal_stopped_at_ms AS stopped_at_ms FROM refund_attempts WHERE renewal_stopped_at_ms IS NOT NULL) AS subscription_renewal_stops) AS stops,
    (SELECT COUNT(*) FROM subscription_standing) AS subscriptions`).first()
      );
      expect(retained).toEqual({
        attempts: 0,
        outbox: 0,
        claims: 0,
        outcomes: 0,
        adjustments: 0,
        stops: 0,
        subscriptions: 0,
      });
    })
  )
);

it.each(["missing", "recovery-audience", "expired", "mismatched-user"])(
  "refuses %s correction reads through Public and Core without disclosure or financial effects",
  (scenario) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const prepared = yield* setup();
        const db = prepared.environment.DB;
        yield* seedRefundCharge(db);
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "WITH fixture_user(id,time_zone) AS (VALUES ('10000000-0000-4000-8000-000000000002','America/Bogota')) INSERT INTO users(id,time_zone,service_market,locale,created_at_ms) SELECT id,time_zone,'CO','es-CO',0 FROM fixture_user"
            )
            .run()
        );
        const retained = yield* startRefund({
          db,
          environment: "sandbox",
          authority: {
            operatorId: "support-operator",
            permission: "billing.refund",
            expiresAtMs: (yield* Clock.currentTimeMillis) + 60000,
          },
          input: {
            userId: "10000000-0000-4000-8000-000000000001",
            billingAttemptId: "40000000-0000-4000-8000-000000000001",
            requestId: "50000000-0000-4000-8000-000000000001",
            intent: { kind: "refund", money: { amount: "4000", currency: "COP" } },
            reason: "user-request",
          },
        });
        const snapshot = (): Effect.Effect<ReadonlyArray<unknown>, Cause.UnknownError> =>
          Effect.tryPromise(() =>
            db.batch(
              [
                "refund_attempts",
                "(SELECT rowid,id AS refund_id,1 AS version,dispatch_last_attempt_at_ms AS last_attempt_at_ms,published_at_ms,verification_attempts,last_verification_at_ms FROM refund_attempts WHERE verification_attempts IS NOT NULL)",
                "(SELECT rowid,id AS refund_id,submission_claimed_at_ms AS claimed_at_ms FROM refund_attempts WHERE submission_claimed_at_ms IS NOT NULL)",
                "(SELECT rowid,id AS refund_id,provider_refund_id AS provider_id,verified_status,observed_at_ms FROM refund_attempts WHERE verified_status IS NOT NULL)",
                "(SELECT rowid,id AS refund_id,adjusted_attempt_id AS attempt_id,access_ends_at_ms AS ends_at_ms FROM refund_attempts WHERE adjusted_attempt_id IS NOT NULL)",
                "(SELECT rowid,id AS refund_id,renewal_stopped_user_id AS user_id,renewal_stopped_at_ms AS stopped_at_ms FROM refund_attempts WHERE renewal_stopped_at_ms IS NOT NULL)",
                "subscription_standing",
                "billing_attempts",
                "(SELECT rowid,id AS attempt_id,paid_starts_at_ms AS starts_at_ms,paid_ends_at_ms AS ends_at_ms,paid_renewal_anchor_ms AS renewal_anchor_ms FROM billing_attempt_context WHERE paid_starts_at_ms IS NOT NULL)",
                "(SELECT transaction_id,attempt_id,status,first_observed_at_ms,negative_observed_at_ms,finalized_at_ms FROM billing_provider_transactions WHERE status IS NOT NULL)",
              ].map((table) => db.prepare(`SELECT * FROM ${table}`))
            )
          ).pipe(Effect.map((rows) => rows.map((row) => row.results)));
        const before = yield* snapshot();
        const read = (
          assertion: string,
          userId = "10000000-0000-4000-8000-000000000001"
        ): Promise<Response> =>
          publicSupport(
            new Request(
              `https://api.fidyapp.com/internal/support/billing-refunds/${userId}/${retained.id}`,
              { headers: { "cf-access-jwt-assertion": assertion } }
            ),
            prepared.environment
          );
        const permitted = yield* Effect.tryPromise(() => prepared.token("refund-permission"));
        const visible = yield* Effect.tryPromise(() => read(permitted));
        expect(visible.status).toBe(200);
        expect(yield* Effect.tryPromise(() => visible.json())).toMatchObject({
          data: { id: retained.id, status: "pending" },
        });
        let assertion = yield* Effect.tryPromise(() =>
          prepared.token(
            scenario === "recovery-audience" ? "recovery-permission" : "refund-permission",
            scenario === "expired" ? "-1m" : "5m"
          )
        );
        if (scenario === "missing") assertion = "";
        const refused = yield* Effect.tryPromise(() =>
          read(
            assertion,
            scenario === "mismatched-user"
              ? "10000000-0000-4000-8000-000000000002"
              : "10000000-0000-4000-8000-000000000001"
          )
        );
        expect(refused.status).toBe(scenario === "mismatched-user" ? 404 : 401);
        expect(yield* Effect.tryPromise(() => refused.json())).toEqual({
          error: {
            code: scenario === "mismatched-user" ? "charge-unavailable" : "unauthenticated",
          },
        });
        expect(prepared.admissions).toEqual([]);
        expect(yield* snapshot()).toEqual(before);
      })
    )
);

it("aborts the owned signing-key lookup when its request is cancelled without cancelling another authorization", () => {
  const controller = new AbortController();
  return Effect.runPromise(
    Effect.gen(function* () {
      const prepared = yield* setup();
      const assertion = yield* Effect.tryPromise(() => prepared.token("refund-permission"));
      const firstEntered = Promise.withResolvers<AbortSignal>();
      const secondEntered = Promise.withResolvers<AbortSignal>();
      const firstReply = Promise.withResolvers<Response>();
      const secondReply = Promise.withResolvers<Response>();
      let lookups = 0;
      vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const incoming = new Request(input, init);
        lookups++;
        const reply = lookups === 1 ? firstReply : secondReply;
        incoming.signal.addEventListener(
          "abort",
          () => reply.reject(new DOMException("Cancelled lookup", "AbortError")),
          { once: true }
        );
        if (lookups === 1) firstEntered.resolve(incoming.signal);
        else secondEntered.resolve(incoming.signal);
        return reply.promise;
      });
      const first = Effect.runPromiseExit(
        Effect.tryPromise(() =>
          handleRefundSupport({
            request: new Request(request(assertion), { signal: controller.signal }),
            environment: prepared.environment,
          })
        )
      );
      const firstSignal = yield* Effect.tryPromise(() => firstEntered.promise);
      const second = Effect.runPromiseExit(
        Effect.tryPromise(() =>
          handleRefundSupport({ request: request(assertion), environment: prepared.environment })
        )
      );
      controller.abort();
      const interrupted = yield* Effect.tryPromise(() => first);
      expect(Exit.isFailure(interrupted)).toBe(true);
      expect(firstSignal.aborted).toBe(true);
      expect(prepared.admissions).toEqual([]);
      const secondSignal = yield* Effect.tryPromise(() => secondEntered.promise);
      expect(secondSignal.aborted).toBe(false);
      secondReply.resolve(Response.json(prepared.signingKeys));
      const permitted = yield* Effect.tryPromise(() => second);
      expect(Exit.isSuccess(permitted)).toBe(true);
      if (Exit.isSuccess(permitted)) expect(permitted.value.status).toBe(202);
      expect(prepared.admissions).toHaveLength(1);
    })
  );
});

it("forwards billing support to Core without inheriting PAT or recovery permission", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const prepared = yield* setup();
      const recovery = yield* Effect.tryPromise(() => prepared.token("recovery-permission"));
      const refused = yield* Effect.tryPromise(() =>
        publicSupport(request(recovery), prepared.environment)
      );
      expect(refused.status).toBe(401);
      expect(prepared.admissions).toEqual([]);
      const pat = request("");
      pat.headers.set("authorization", "Bearer valid-pat-is-not-refund-authority");
      const noGrant = yield* Effect.tryPromise(() => publicSupport(pat, prepared.environment));
      expect(noGrant.status).toBe(401);
      const permitted = yield* Effect.tryPromise(() => prepared.token("refund-permission"));
      const accepted = yield* Effect.tryPromise(() =>
        publicSupport(request(permitted), prepared.environment)
      );
      expect(accepted.status).toBe(202);
      expect(prepared.admissions).toHaveLength(1);
    })
  ));
