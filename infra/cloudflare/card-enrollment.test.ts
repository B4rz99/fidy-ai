import type { Miniflare } from "miniflare";
import { afterEach, expect, it, vi } from "vitest";
import { CardEnrollment } from "@fidy/server/client";
import { Schema } from "effect";
import { handleCardEnrollment } from "./card-enrollment";
import { browserOrigins, localCanonicalReadBearer } from "./topology";
import { makePublicWorker } from "./public-worker";
import { cloudflareWorkerTelemetry } from "./telemetry";
import { makeCardEnrollmentD1 } from "./card-enrollment-d1.test-fixture";

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
// @effect-diagnostics-next-line asyncFunction:off
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(instances.splice(0).map((mf) => mf.dispose()));
});

// @effect-diagnostics-next-line asyncFunction:off
const setup = async (): Promise<{
  db: D1Database;
  environment: {
    DB: D1Database;
    BROWSER_ORIGIN: string;
    WOMPI_ENVIRONMENT: string;
    WOMPI_PUBLIC_KEY: string;
    WOMPI_PRIVATE_KEY: string;
    WOMPI_INTEGRITY_SECRET: string;
  };
  request: (
    path: string,
    method?: string,
    body?: object,
    options?: { origin?: string; cookie?: string }
  ) => Request;
}> => {
  const name = `card-flow-${++counter}`;
  const { db, instance } = await makeCardEnrollmentD1(name, [
    "CREATE TABLE users (id TEXT PRIMARY KEY, time_zone TEXT NOT NULL) STRICT",
    "CREATE TABLE verified_email_credentials (user_id TEXT PRIMARY KEY, email_address TEXT NOT NULL) STRICT",
    "CREATE TABLE onboarding_consent_records (user_id TEXT PRIMARY KEY) STRICT",
    `CREATE TABLE web_sessions (user_id TEXT NOT NULL, token_digest BLOB NOT NULL,
      revoked_at_ms INTEGER, fresh_until_ms INTEGER NOT NULL, idle_expires_at_ms INTEGER NOT NULL,
      hard_expires_at_ms INTEGER NOT NULL) STRICT`,
  ]);
  instances.push(instance);
  await db
    .prepare("INSERT INTO users VALUES (?, 'America/Bogota'), (?, 'America/Bogota')")
    .bind(userA, userB)
    .run();
  await db
    .prepare(
      "INSERT INTO verified_email_credentials VALUES (?, 'payer@example.com'), (?, 'other@example.com')"
    )
    .bind(userA, userB)
    .run();
  await db
    .prepare("INSERT INTO onboarding_consent_records VALUES (?), (?)")
    .bind(userA, userB)
    .run();
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
  );
  // @effect-diagnostics-next-line globalDate:off
  const now = Date.now();
  await db
    .prepare("INSERT INTO web_sessions VALUES (?, ?, NULL, ?, ?, ?)")
    .bind(userA, digest, now + 600_000, now + 600_000, now + 600_000)
    .run();
  const environment = {
    DB: db,
    BROWSER_ORIGIN: browserOrigins.local,
    WOMPI_ENVIRONMENT: "sandbox",
    WOMPI_PUBLIC_KEY: publicKey,
    WOMPI_PRIVATE_KEY: secret,
    WOMPI_INTEGRITY_SECRET: `test_integrity_${"f1d7c0de".repeat(3)}`,
  };
  const request = (
    path: string,
    method = "GET",
    body?: object,
    options: { origin?: string; cookie?: string } = {}
  ): Request =>
    new Request(`https://core.internal${path}`, {
      method,
      headers: {
        origin: options.origin ?? browserOrigins.local,
        cookie: `__Host-fidy_session=${options.cookie ?? token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { db, environment, request };
};

const providerBody = (url: URL, status: "PENDING" | "AVAILABLE"): string => {
  if (url.href.includes("/v1/merchants/")) return merchant;
  if (url.href.includes("/v1/payment_sources/3891")) {
    return JSON.stringify({ data: { id: 3891, status, customer_email: "payer@example.com" } });
  }
  return JSON.stringify({ data: { id: 3891, status } });
};

// @effect-diagnostics-next-line asyncFunction:off
it("prepares a Price and creates exactly one provider source and pending BillingAttempt across duplicate submissions", async () => {
  const { db, environment, request } = await setup();
  const provider = vi.fn((req: URL, _init?: RequestInit): Promise<Response> =>
    Promise.resolve(
      new Response(providerBody(req, "AVAILABLE"), { status: _init?.method === "POST" ? 201 : 200 })
    )
  );
  vi.stubGlobal("fetch", provider);
  const prepared = await handleCardEnrollment(
    request("/web/subscription/card-enrollments/prepare", "POST", { priceId }),
    environment
  );
  expect(prepared.status).toBe(200);
  const preparedBody: unknown = await prepared.json();
  expect(preparedBody).toMatchObject({
    status: "prepared",
    price: { money: { amount: "9900", currency: "COP" } },
    paymentSourceMode: "create",
  });
  const data = Schema.decodeUnknownSync(Schema.toCodecJson(CardEnrollment))(preparedBody);
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
    handleCardEnrollment(
      request("/web/subscription/card-enrollments/submit", "POST", submission),
      environment
    );
  const changedEmail = await handleCardEnrollment(
    request("/web/subscription/card-enrollments/submit", "POST", {
      ...submission,
      billingEmail: "wrong@example.com",
    }),
    environment
  );
  expect(changedEmail.status).toBe(400);
  expect(changedEmail.headers.get("cache-control")).toBe("no-store");
  expect(provider.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  const concurrent = await Promise.all([send(), send()]);
  expect(concurrent.every((response) => response.status === 200)).toBe(true);
  const first = await send();
  const result = await first.json();
  expect(result).toMatchObject({
    status: "payment-pending",
    billingAttempt: { status: "pending", money: { amount: "9900" } },
  });
  expect(JSON.stringify(result)).not.toMatch(/3891|tok_test_browser_only|prv_test|fidy-/u);
  expect((await send()).status).toBe(200);
  const next = await handleCardEnrollment(
    request("/web/subscription/card-enrollments/prepare", "POST", { priceId }),
    environment
  );
  const second: unknown = await next.json();
  expect(second).toMatchObject({ status: "prepared", paymentSourceMode: "reuse" });
  const secondEnrollment = Schema.decodeUnknownSync(Schema.toCodecJson(CardEnrollment))(second);
  if (secondEnrollment.status !== "prepared") throw new Error("expected second preparation");
  expect(
    (
      await handleCardEnrollment(
        request("/web/subscription/card-enrollments/submit", "POST", {
          enrollmentId: secondEnrollment.enrollmentId,
          paymentSourceMode: "reuse",
          paymentRequestId: submission.paymentRequestId,
          billingEmail: submission.billingEmail,
          decisions: submission.decisions,
        }),
        environment
      )
    ).status
  ).toBe(400);
  const reuse = await handleCardEnrollment(
    request("/web/subscription/card-enrollments/submit", "POST", {
      enrollmentId: secondEnrollment.enrollmentId,
      paymentSourceMode: "reuse",
      billingEmail: submission.billingEmail,
      decisions: submission.decisions,
      paymentRequestId: "30000000-0000-4000-8000-000000000002",
    }),
    environment
  );
  expect(reuse.status).toBe(200);
  expect(await reuse.json()).toMatchObject({ status: "payment-pending" });
  expect(provider.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  expect((await db.prepare("SELECT id FROM card_payment_sources").all()).results).toHaveLength(1);
  expect((await db.prepare("SELECT id FROM billing_attempts").all()).results).toHaveLength(2);
});

// @effect-diagnostics-next-line asyncFunction:off
it("reserves preparation before calling Wompi and bounds failed preparations", async () => {
  const { db, environment, request } = await setup();
  let release: (response: Response) => void = () => {
    throw new Error("merchant request not started");
  };
  // @effect-diagnostics-next-line newPromise:off
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const provider = vi.fn((): Promise<Response> => pending);
  vi.stubGlobal("fetch", provider);
  const prepare = (): Promise<Response> =>
    handleCardEnrollment(
      request("/web/subscription/card-enrollments/prepare", "POST", { priceId }),
      environment
    );
  const first = prepare();
  await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));
  expect((await prepare()).status).toBe(503);
  expect(provider).toHaveBeenCalledTimes(1);
  release(new Response("{}", { status: 400 }));
  expect((await first).status).toBe(503);
  expect((await db.prepare("SELECT status FROM card_enrollments").first())?.status).toBe("refused");
  // Other failed reservations consume the same rate-limit window, regardless of provider outcome.
  // @effect-diagnostics-next-line globalDate:off
  const now = Date.now();
  await db.batch(
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
  );
  expect((await prepare()).status).toBe(503);
  expect(provider).toHaveBeenCalledTimes(1);
  expect((await db.prepare("SELECT id FROM card_enrollments").all()).results).toHaveLength(12);
});

// @effect-diagnostics-next-line asyncFunction:off
it("rejects a foreign Origin or missing session without provider or persistence effects", async () => {
  const { db, environment, request } = await setup();
  const provider = vi.fn(() => Promise.resolve(new Response(merchant)));
  vi.stubGlobal("fetch", provider);
  expect(
    (
      await handleCardEnrollment(
        request(
          "/web/subscription/card-enrollments/prepare",
          "POST",
          { priceId },
          { origin: "https://evil.test" }
        ),
        environment
      )
    ).status
  ).toBe(403);
  expect(
    (
      await handleCardEnrollment(
        request(
          "/web/subscription/card-enrollments/prepare",
          "POST",
          { priceId },
          { cookie: "wrong" }
        ),
        environment
      )
    ).status
  ).toBe(401);
  expect(provider).not.toHaveBeenCalled();
  expect((await db.prepare("SELECT id FROM card_enrollments").all()).results).toEqual([]);
});

// @effect-diagnostics-next-line asyncFunction:off
it("never repeats a source POST after a provider timeout without a known candidate", async () => {
  const { db, environment, request } = await setup();
  const provider = vi.fn((url: URL, init?: RequestInit): Promise<Response> =>
    init?.method === "POST"
      ? Promise.reject(new Error("provider timeout"))
      : Promise.resolve(new Response(providerBody(url, "AVAILABLE"), { status: 200 }))
  );
  vi.stubGlobal("fetch", provider);
  const prepared = await handleCardEnrollment(
    request("/web/subscription/card-enrollments/prepare", "POST", { priceId }),
    environment
  );
  const decoded = Schema.decodeUnknownSync(Schema.toCodecJson(CardEnrollment))(
    await prepared.json()
  );
  if (decoded.status !== "prepared") throw new Error("expected prepared enrollment");
  const send = (): Promise<Response> =>
    handleCardEnrollment(
      request("/web/subscription/card-enrollments/submit", "POST", {
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
      environment
    );
  expect(await (await send()).json()).toMatchObject({ status: "source-verifying" });
  expect(await (await send()).json()).toMatchObject({ status: "source-verifying" });
  expect(provider.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  expect((await db.prepare("SELECT id FROM card_payment_sources").all()).results).toHaveLength(0);
  expect((await db.prepare("SELECT id FROM billing_attempts").all()).results).toHaveLength(0);
});

// @effect-diagnostics-next-line asyncFunction:off
it("rejects a cross-Origin public submission before Core delegation", async () => {
  const core = vi.fn(() => Promise.resolve(new Response("must not call")));
  const ingress = makePublicWorker(cloudflareWorkerTelemetry);
  const environment = {
    BROWSER_ORIGIN: browserOrigins.local,
    CORE: { fetch: core },
    LOCAL_CANONICAL_READ_BEARER: localCanonicalReadBearer,
    RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
  };
  const rejected = await ingress.fetch(
    new Request("https://api.fidyapp.com/web/subscription/card-enrollments/submit", {
      method: "POST",
      headers: { origin: "https://evil.test" },
      body: "{}",
    }),
    environment
  );
  expect(rejected.status).toBe(403);
  expect(rejected.headers.get("cache-control")).toBe("no-store");
  expect(core).not.toHaveBeenCalled();
});

// @effect-diagnostics-next-line asyncFunction:off
it("resolves a pending provider source by authenticated lookup without another source POST", async () => {
  const { db, environment, request } = await setup();
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
  const prepared = await handleCardEnrollment(
    request("/web/subscription/card-enrollments/prepare", "POST", { priceId }),
    environment
  );
  const decoded = Schema.decodeUnknownSync(Schema.toCodecJson(CardEnrollment))(
    await prepared.json()
  );
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
    handleCardEnrollment(
      request("/web/subscription/card-enrollments/submit", "POST", payload),
      environment
    );
  expect(await (await send()).json()).toMatchObject({ status: "source-verifying" });
  expect((await db.prepare("SELECT id FROM card_payment_sources").all()).results).toHaveLength(0);
  available = true;
  const lookups = provider.mock.calls.length;
  const burst = await Promise.all([send(), send(), send()]);
  expect(burst.every((response) => response.status === 200)).toBe(true);
  expect(provider.mock.calls).toHaveLength(lookups);
  await db
    .prepare("UPDATE card_enrollments SET last_verification_at_ms = 0 WHERE id = ?")
    .bind(decoded.enrollmentId)
    .run();
  const resume = (): Promise<Response> =>
    handleCardEnrollment(
      request("/web/subscription/card-enrollments/submit", "POST", {
        enrollmentId: decoded.enrollmentId,
        paymentSourceMode: "reuse",
        paymentRequestId: payload.paymentRequestId,
        billingEmail: payload.billingEmail,
        decisions: payload.decisions,
      }),
      environment
    );
  mismatched = true;
  expect(await (await resume()).json()).toMatchObject({ status: "source-verifying" });
  expect((await db.prepare("SELECT id FROM card_payment_sources").all()).results).toHaveLength(0);
  expect((await db.prepare("SELECT id FROM billing_attempts").all()).results).toHaveLength(0);
  mismatched = false;
  await db
    .prepare("UPDATE card_enrollments SET last_verification_at_ms = 0 WHERE id = ?")
    .bind(decoded.enrollmentId)
    .run();
  expect(await (await resume()).json()).toMatchObject({ status: "payment-pending" });
  expect(provider.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  expect((await db.prepare("SELECT id FROM card_payment_sources").all()).results).toHaveLength(1);
  expect((await db.prepare("SELECT id FROM billing_attempts").all()).results).toHaveLength(1);
});
