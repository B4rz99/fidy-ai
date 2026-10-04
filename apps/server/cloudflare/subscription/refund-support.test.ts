import { afterEach, expect, it, vi } from "vitest";
import { Effect, Option, Schema } from "effect";
import { type Miniflare } from "miniflare";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { makePaymentEnrollmentD1 } from "./payment-enrollment-d1.test-fixture";
import { RefundSupportAdmission, type RefundSupportEnvironment } from "./contract";
import { approvedWorkersAiModel } from "../../src/shell/hosted-inference/contract";
import coreWorker from "../core-worker";
import publicWorker from "../public-worker";
import { handleRefundSupport } from "./runtime";

let instance: Option.Option<Miniflare> = Option.none();
let counter = 0;
afterEach(() => {
  vi.unstubAllGlobals();
  const disposed = Option.isSome(instance) ? instance.value.dispose() : Promise.resolve();
  instance = Option.none();
  return disposed;
});
const setup = Effect.fnUntraced(function* () {
  const number = ++counter;
  const made = yield* makePaymentEnrollmentD1(`refund-support-${number}`, [
    "CREATE TABLE users (id TEXT PRIMARY KEY, time_zone TEXT NOT NULL) STRICT",
  ]);
  instance = Option.some(made.instance);
  const keys = yield* Effect.tryPromise(() => generateKeyPair("RS256", { extractable: true }));
  const jwk = yield* Effect.tryPromise(() => exportJWK(keys.publicKey));
  const issuer = `https://refund-support-${number}.cloudflareaccess.com`;
  const admissions: unknown[] = [];
  const services = yield* Effect.context<never>();
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    expect(request.url).toBe(`${issuer}/cdn-cgi/access/certs`);
    expect(request.headers.has("cf-access-jwt-assertion")).toBe(false);
    expect(request.headers.has("authorization")).toBe(false);
    expect(request.headers.has("traceparent")).toBe(false);
    return Promise.resolve(
      Response.json({ keys: [{ ...jwk, kid: "billing-test", alg: "RS256", use: "sig" }] })
    );
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
  return { environment, token, admissions };
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
          KAPSO_WEBHOOK_SECRET: "",
          WHATSAPP_BUSINESS_PORTFOLIO_ID: "",
        }),
    },
  });
const request = (assertion: string): Request =>
  new Request("https://api.fidyapp.com/internal/support/billing-refunds", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-access-jwt-assertion": assertion },
    body: Schema.encodeSync(Schema.fromJsonString(RefundSupportAdmission.fields.input))({
      userId: "10000000-0000-4000-8000-000000000001",
      billingAttemptId: "40000000-0000-4000-8000-000000000001",
      requestId: "50000000-0000-4000-8000-000000000001",
      intent: { kind: "refund", money: { amount: "4000", currency: "COP" } },
      reason: "user-request",
    }),
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
