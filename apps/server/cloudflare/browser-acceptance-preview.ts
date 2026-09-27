import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { Miniflare } from "miniflare";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import {
  UserTransactionCoordinator,
  makeCoreWorker,
  runBillingCollectionWorkflow,
} from "./browser-acceptance-core-module";
import { newId } from "./pats/pat-shared";

const { makePublicWorker } = await import("./public-worker");
const { makeWorkerTelemetry } = await import("./runtime/telemetry");
const { browserOrigins } = await import("./runtime/topology");
const { approvedWorkersAiModel } = await import("@fidy/server/hosted-inference-model");

const certificate = Bun.env.PLAYWRIGHT_TLS_CERT;
const key = Bun.env.PLAYWRIGHT_TLS_KEY;
if (certificate === undefined || key === undefined) {
  throw new Error("Browser acceptance requires TLS certificate and key");
}

const miniflare = new Miniflare({
  workers: [
    {
      config: {
        compatibilityDate: "2026-09-08",
        env: { DB: { id: "browser-acceptance", type: "d1" } },
        manifest: {
          mainModule: "index.mjs",
          modules: {
            "index.mjs": {
              contents: "export default {fetch() {return new Response('ok')}}",
              type: "esm",
            },
          },
        },
        name: "browser-acceptance",
        type: "worker",
      },
    },
  ],
});
await miniflare.ready;
const db = await miniflare.getD1Database("DB");
const migrations = [
  "0001_categories",
  "0002_resource_admission",
  "0003_pending_consent",
  "0004_onboarding_email",
  "0005_verified_onboarding",
  "0006_browser_login",
  "0007_browser_pairing_email",
  "0008_support_recovery",
  "0009_email_replacement",
  "0009_card_enrollment",
  "0009_transactions",
  "0010_pat_lifecycle",
  "0011_transaction_corrections",
  "0012_billing_collection",
  "0012_statement_staging",
  "0012_transaction_search",
  "0013_category_keyword_rules",
  "0013_transaction_reconciliation",
  "0014_memory",
  "0015_statement_submission",
  "0016_budgets",
  "0016_hosted_turn",
  "0016_subscription_standing",
  "0017_hosted_compaction",
  "0017_forwarded_email",
  "0017_statement_dispatch",
  "0018_dashboard",
  "0018_batch_envelope_audit",
  "0019_canonical_child_guards",
  "0020_dashboard_projection",
];
const applyMigration = (name: string): Promise<void> =>
  Bun.file(new URL(`./migrations/${name}.sql`, import.meta.url))
    .text()
    .then((sql) =>
      sql
        .replace(/^--.*$/gmu, "")
        .trim()
        .split(/;\s*\n(?=CREATE |ALTER |INSERT |DROP |$)/u)
        .reduce<Promise<void>>(
          (previous, statement) =>
            previous.then(() => db.prepare(statement).run()).then(() => undefined),
          Promise.resolve()
        )
    );
await migrations.reduce<Promise<void>>(
  (previous, name) => previous.then(() => applyMigration(name)),
  Promise.resolve()
);

// This identity is confined to Miniflare. The separate loopback operator simulates a verified
// WhatsApp approval; the browser still obtains its cookie only by redeeming with the real Core.
const fixtureUserId = "24000000-0000-4000-8000-000000000241";
const firstCardUserId = "24000000-0000-4000-8000-000000000281";
const otherUserId = "24000000-0000-4000-8000-000000000261";
const otherTransactionId = "24000000-0000-4000-8000-000000000262";
const backupRecoveryCode = "ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2";
const accessIssuer = "https://acceptance.cloudflareaccess.com";
const accessAudience = "browser-acceptance-support";
const replacementCode = "ABCD-EFGH-JKLM-NPQR-STUV-WXYZ";
const replacementEmail = "nuevo@example.com";
const now = Effect.runSync(Clock.currentTimeMillis);
const trialDurationMs = 604_800_000;
type SeedIdentity = Readonly<{
  userId: string;
  bsuid: string;
  email: string;
  consentId: string;
  disclosure: string;
  decision: string;
}>;
// @effect-diagnostics-next-line asyncFunction:off
const seedIdentity = async (identity: SeedIdentity): Promise<void> => {
  await db
    .prepare(
      "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?,?,?,?,?)"
    )
    .bind(identity.userId, "CO", "es-CO", "America/Bogota", now)
    .run();
  await db
    .prepare(
      "INSERT INTO whatsapp_identities (user_id, portfolio_id, bsuid, verified_at_ms) VALUES (?,?,?,?)"
    )
    .bind(identity.userId, "acceptance-portfolio", identity.bsuid, now)
    .run();
  await db
    .prepare(
      "INSERT INTO verified_email_credentials (user_id, email_address, verified_at_ms) VALUES (?,?,?)"
    )
    .bind(identity.userId, identity.email, now)
    .run();
  await db
    .prepare("INSERT INTO trial_periods (user_id, started_at_ms, ends_at_ms) VALUES (?,?,?)")
    .bind(identity.userId, now, now + trialDurationMs)
    .run();
  await db
    .prepare(`INSERT INTO onboarding_consent_records
    (id, user_id, disclosure_json, disclosure_message_id, decision_message_id,
     decision_received_at_ms, accepted_at_ms) VALUES (?,?,?,?,?,?,?)`)
    .bind(
      identity.consentId,
      identity.userId,
      "{}",
      identity.disclosure,
      identity.decision,
      now,
      now
    )
    .run();
};
await seedIdentity({
  userId: fixtureUserId,
  bsuid: "CO.Acceptance",
  email: "usuario@example.com",
  consentId: "24000000-0000-4000-8000-000000000260",
  disclosure: "disclosure",
  decision: "decision",
});
await db
  .prepare(
    "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?,?,?,?,?)"
  )
  .bind(otherUserId, "CO", "es-CO", "America/Bogota", now)
  .run();
await db
  .prepare(`INSERT INTO transactions
  (id, user_id, amount, currency, direction, counterparty, category_id, occurred_at, created_at)
  VALUES (?,?,?,?,?,?,?,?,?)`)
  .bind(
    otherTransactionId,
    otherUserId,
    "100",
    "COP",
    "outflow",
    "OTHER-USER-PRIVATE",
    "10000000-0000-4000-8000-000000000001",
    "2026-09-27T12:00:00.000Z",
    "2026-09-27T12:00:00.000Z"
  )
  .run();
const sourceEnrollmentId = "24000000-0000-4000-8000-000000000271";
const sourceId = 3891;
const firstCardSourceId = 3892;
const enrollmentLifetimeMs = 900_000;
await db
  .prepare(`INSERT INTO card_enrollments
  (id, user_id, price_id, billing_email, status, payment_source_mode, contracts_json,
   disclosure_json, prepared_at_ms, expires_at_ms, wompi_candidate_source_id)
  VALUES (?, ?, ?, ?, 'creating', 'create', '{}', '{}', ?, ?, ?)`)
  .bind(
    sourceEnrollmentId,
    fixtureUserId,
    "22700000-0000-4000-8000-000000000001",
    "usuario@example.com",
    now,
    now + enrollmentLifetimeMs,
    sourceId
  )
  .run();
await db
  .prepare(`INSERT INTO card_payment_sources
  (id, user_id, enrollment_id, wompi_source_id, billing_email, created_at_ms)
  VALUES (?, ?, ?, ?, ?, ?)`)
  .bind(
    "24000000-0000-4000-8000-000000000272",
    fixtureUserId,
    sourceEnrollmentId,
    sourceId,
    "usuario@example.com",
    now
  )
  .run();
await db
  .prepare("UPDATE card_enrollments SET status = 'available' WHERE id = ?")
  .bind(sourceEnrollmentId)
  .run();
// A second User has verified credentials and consent but no CardPaymentSource. It must
// traverse first-time tokenization instead of silently reusing the primary User's source.
await seedIdentity({
  userId: firstCardUserId,
  bsuid: "CO.FirstCard",
  email: "tarjeta@example.com",
  consentId: "24000000-0000-4000-8000-000000000282",
  disclosure: "first-card-disclosure",
  decision: "first-card-decision",
});

const recoveryDigest = new Uint8Array(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(backupRecoveryCode))
);
await db
  .prepare(
    "INSERT INTO backup_recovery_credentials (user_id, code_digest, created_at_ms) VALUES (?,?,?)"
  )
  .bind(fixtureUserId, recoveryDigest, now)
  .run();

const providerPublicKey = `pub_test_${"f1d7c0de".repeat(3)}`;
const providerPrivateKey = `prv_test_${"f1d7c0de".repeat(3)}`;
const signedAcceptance = (permalink: string, hash: string): string =>
  `header.${btoa(JSON.stringify({ permalink, file_hash: hash }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "")}.signature`;
const contractHashLength = 64;
const merchantBody = {
  data: {
    presigned_acceptance: {
      acceptance_token: signedAcceptance(
        "https://wompi.example/end.pdf",
        "2".repeat(contractHashLength)
      ),
      permalink: "https://wompi.example/end.pdf",
    },
    presigned_personal_data_auth: {
      acceptance_token: signedAcceptance(
        "https://wompi.example/data.pdf",
        "3".repeat(contractHashLength)
      ),
      permalink: "https://wompi.example/data.pdf",
    },
  },
};
const WompiCharge = Schema.Struct({
  reference: Schema.String,
  amount_in_cents: Schema.Finite,
  payment_source_id: Schema.Finite,
  currency: Schema.String,
  customer_email: Schema.String,
});
const monthlyChargeCents = 2_890_000;
const transactionPrefix = "acceptance-transaction-";
type ProviderAttempt = Readonly<{
  id: string;
  wompi_reference: string;
  amount: string;
  wompi_source_id: number;
  billing_email: string;
}>;
const matchesCharge = (charge: typeof WompiCharge.Type, attempt: ProviderAttempt): boolean =>
  charge.amount_in_cents === monthlyChargeCents &&
  charge.currency === "COP" &&
  charge.payment_source_id ===
    (attempt.billing_email === "tarjeta@example.com" ? firstCardSourceId : sourceId) &&
  charge.customer_email === attempt.billing_email &&
  attempt.amount === "28900";
// @effect-diagnostics-next-line asyncFunction:off
const decodeCharge = async (request: Request): Promise<Option.Option<typeof WompiCharge.Type>> => {
  if (request.method !== "POST") return Option.none();
  const body: unknown = await request.json();
  return Schema.decodeUnknownOption(WompiCharge)(body);
};
const providerKey = (
  request: Request,
  charge: Option.Option<typeof WompiCharge.Type>
): Option.Option<string> =>
  request.method === "POST"
    ? Option.map(charge, (decoded) => decoded.reference)
    : Option.fromNullishOr(
        new URL(request.url).pathname.split("/v1/transactions/")[1]?.replace(transactionPrefix, "")
      );
// @effect-diagnostics-next-line asyncFunction:off
const transactionResponse = async (request: Request): Promise<Response> => {
  const isCreate = request.method === "POST";
  const charge = await decodeCharge(request);
  const key = providerKey(request, charge);
  if (Option.isNone(key)) return new Response(null, { status: 400 });
  const column = isCreate ? "a.wompi_reference" : "a.id";
  const attempt = await db
    .prepare(`SELECT a.id, a.wompi_reference, a.amount, s.wompi_source_id,
    s.billing_email FROM billing_attempts AS a JOIN card_payment_sources AS s ON s.user_id = a.user_id
    WHERE ${column} = ?`)
    .bind(key.value)
    .first<ProviderAttempt>();
  if (attempt === null) return new Response(null, { status: 404 });
  if (isCreate && !matchesCharge(Option.getOrThrow(charge), attempt)) {
    return new Response(null, { status: 400 });
  }
  return Response.json({
    data: {
      id: `${transactionPrefix}${attempt.id}`,
      reference: attempt.wompi_reference,
      status: "APPROVED",
      amount_in_cents: monthlyChargeCents,
      currency: "COP",
      payment_source_id: attempt.wompi_source_id,
      finalized_at: DateTime.formatIso(
        DateTime.makeUnsafe(Effect.runSync(Clock.currentTimeMillis))
      ),
    },
  });
};
const providerResponse = (request: Request): Promise<Response> => {
  const requestUrl = request.url;
  if (requestUrl.includes("/v1/transactions")) return transactionResponse(request);
  if (requestUrl.includes("/v1/merchants/")) return Promise.resolve(Response.json(merchantBody));
  if (requestUrl.includes(`/v1/payment_sources/${firstCardSourceId}`)) {
    return Promise.resolve(
      Response.json({
        data: { id: firstCardSourceId, status: "AVAILABLE", customer_email: "tarjeta@example.com" },
      })
    );
  }
  if (requestUrl.endsWith("/v1/payment_sources")) {
    return Promise.resolve(
      Response.json({ data: { id: firstCardSourceId, status: "PENDING" } }, { status: 201 })
    );
  }
  if (requestUrl.includes(`/v1/payment_sources/${sourceId}`)) {
    return Promise.resolve(
      Response.json({
        data: { id: sourceId, status: "AVAILABLE", customer_email: "usuario@example.com" },
      })
    );
  }
  return Promise.resolve(Response.json({ data: { id: sourceId, status: "PENDING" } }));
};
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = {
  ...(await exportJWK(publicKey)),
  kid: "acceptance-support",
  alg: "RS256",
  use: "sig",
};
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply: (target, thisArg, args): unknown => {
    const requestUrl: unknown = args[0];
    const url = requestUrl instanceof Request ? requestUrl.url : String(requestUrl);
    if (url === `${accessIssuer}/cdn-cgi/access/certs`) {
      return Promise.resolve(Response.json({ keys: [jwk] }));
    }
    if (url.startsWith("https://sandbox.wompi.co/")) {
      const outbound: unknown = Reflect.construct(Request, args);
      if (!(outbound instanceof Request)) {
        return Promise.resolve(new Response(null, { status: 400 }));
      }
      return providerResponse(outbound);
    }
    return Reflect.apply(target, thisArg, args);
  },
});
const assertionLifetimeSeconds = 300;
const millisecondsPerSecond = 1_000;
const assertion = (): Promise<string> => {
  const issuedAt = Math.floor(Effect.runSync(Clock.currentTimeMillis) / millisecondsPerSecond);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "acceptance-support" })
    .setIssuer(accessIssuer)
    .setAudience(accessAudience)
    .setSubject("acceptance-operator")
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + assertionLifetimeSeconds)
    .sign(privateKey);
};
const proofSecretOffset = 10;
const publicCodeLength = 9;
const proofLifetimeMs = 600_000;
const noContent = 204;
const conflict = 409;
const deliverProof = (
  commit: (digest: Uint8Array, expiry: number) => Promise<D1Result>
): Promise<Response> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(replacementCode.slice(proofSecretOffset)))
    .then((digest) =>
      commit(new Uint8Array(digest), Effect.runSync(Clock.currentTimeMillis) + proofLifetimeMs)
    )
    .then(
      (result) => new Response(null, { status: result.meta.changes === 1 ? noContent : conflict })
    );

const deliverReplacementProof = (): Promise<Response> =>
  deliverProof((digest, expiry) =>
    db
      .prepare(`UPDATE email_replacements SET state = 'awaiting_proof',
    public_code = ?, proof_digest = ?, proof_expires_at_ms = ?
    WHERE user_id = ? AND candidate_email = ? AND state = 'awaiting_delivery'`)
      .bind(
        replacementCode.slice(0, publicCodeLength),
        digest,
        expiry,
        fixtureUserId,
        replacementEmail
      )
      .run()
  );

const deliverEmailLoginProof = (code: string): Promise<Response> =>
  deliverProof((digest, expiry) =>
    db
      .prepare(`UPDATE browser_pairing_email_proofs SET state = 'awaiting_proof',
    public_code = ?, proof_digest = ?, proof_expires_at_ms = ?
    WHERE pairing_id = (SELECT id FROM browser_login_pairings WHERE public_code = ?)
      AND state = 'awaiting_delivery'`)
      .bind(replacementCode.slice(0, publicCodeLength), digest, expiry, code)
      .run()
  );

const collectBilling = (): Promise<Response> =>
  db
    .prepare(
      "SELECT id FROM billing_attempts WHERE status = 'pending' ORDER BY created_at_ms DESC LIMIT 1"
    )
    .first<{ id: string }>()
    .then((attempt) =>
      attempt === null
        ? new Response(null, { status: 404 })
        : runBillingCollectionWorkflow({
            environment: {
              DB: db,
              WOMPI_ENVIRONMENT: "sandbox",
              WOMPI_PUBLIC_KEY: providerPublicKey,
              WOMPI_PRIVATE_KEY: providerPrivateKey,
              WOMPI_INTEGRITY_SECRET: `test_integrity_${"f1d7c0de".repeat(3)}`,
            },
            payload: { version: 1, attemptId: attempt.id },
            activity: (_name, _options, run) => run(),
          })
            .then(() =>
              db
                .prepare("SELECT status FROM billing_attempts WHERE id = ?")
                .bind(attempt.id)
                .first<{ status: string }>()
            )
            .then(
              (row) =>
                new Response(null, { status: row?.status === "succeeded" ? noContent : conflict })
            )
    );

const approveWhatsAppPairing = (code: string, userId: string): Promise<Response> =>
  db
    .prepare(
      "SELECT id FROM browser_login_pairings WHERE public_code = ? AND state = 'pending_approval'"
    )
    .bind(code)
    .first<{ id: string }>()
    .then((pairing) =>
      pairing === null
        ? new Response(null, { status: 404 })
        : db
            .prepare(
              "INSERT INTO browser_login_approvals (portfolio_id, message_id, pairing_id, user_id) VALUES (?,?,?,?)"
            )
            .bind("acceptance-portfolio", newId(), pairing.id, userId)
            .run()
            .then(() => new Response(null, { status: noContent }))
    );
const operatorRoute = (request: Request, path: string, method: string): boolean =>
  request.method === method && new URL(request.url).pathname === path;
const operatorCode = (request: Request, path: string): Option.Option<string> =>
  operatorRoute(request, path, "POST")
    ? Option.fromNullishOr(new URL(request.url).searchParams.get("code"))
    : Option.none();
const operator = Bun.serve({
  hostname: "127.0.0.1",
  port: 4175,
  fetch: (request) => {
    if (request.headers.has("origin")) return new Response(null, { status: 403 });
    if (operatorRoute(request, "/assertion", "GET")) {
      return assertion().then(
        (signed) => new Response(signed, { headers: { "cache-control": "no-store" } })
      );
    }
    if (operatorRoute(request, "/email/replacement/deliver", "POST")) {
      return deliverReplacementProof();
    }
    if (operatorRoute(request, "/billing/collect", "POST")) {
      return collectBilling();
    }
    const loginCode = operatorCode(request, "/email/login/deliver");
    if (Option.isSome(loginCode)) return deliverEmailLoginProof(loginCode.value);
    const approvalCode = operatorCode(request, "/approve");
    if (Option.isSome(approvalCode)) {
      const userId =
        new URL(request.url).searchParams.get("firstCard") === "true"
          ? firstCardUserId
          : fixtureUserId;
      return approveWhatsAppPairing(approvalCode.value, userId);
    }
    return new Response(null, { status: 403 });
  },
});
process.stdout.write(`Browser approval fixture listening at ${operator.url}\n`);

const telemetry = makeWorkerTelemetry(() => undefined);
const core = makeCoreWorker(telemetry);
const worker = makePublicWorker(telemetry);
const admissionKeyLength = 32;
const digestHexLength = 64;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 4174,
  tls: { cert: Bun.file(certificate), key: Bun.file(key) },
  fetch: (request) => {
    // Cloudflare supplies this header at the edge; never accept a client-provided value.
    const ingress = new Request(request);
    ingress.headers.set("cf-connecting-ip", "127.0.0.1");
    return worker.fetch(ingress, {
      RELEASE_GIT_SHA: "browser-acceptance",
      BROWSER_ORIGIN: browserOrigins.acceptance,
      LOCAL_CANONICAL_READ_BEARER: "",
      PAT_ADMISSION_KEY: "a".repeat(admissionKeyLength),
      CORE: {
        fetch: (forwarded) =>
          core.fetch(new Request(forwarded), {
            DB: db,
            AI: { run: () => Promise.reject(new Error("unused")) },
            CONTRACT_DIGEST: "a".repeat(digestHexLength),
            RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
            HOSTED_AI_MODEL: approvedWorkersAiModel,
            BROWSER_ORIGIN: browserOrigins.acceptance,
            WOMPI_ENVIRONMENT: "sandbox",
            WOMPI_PUBLIC_KEY: providerPublicKey,
            WOMPI_PRIVATE_KEY: providerPrivateKey,
            WOMPI_INTEGRITY_SECRET: `test_integrity_${"f1d7c0de".repeat(3)}`,
            USER_TRANSACTION_COORDINATOR: {
              getByName: (name): Pick<Fetcher, "fetch"> => ({
                fetch: (command) =>
                  new UserTransactionCoordinator(
                    { id: { name }, storage: { setAlarm: (): Promise<void> => Promise.resolve() } },
                    {
                      DB: db,
                      AI: { run: (): Promise<never> => Promise.reject(new Error("unused")) },
                      HOSTED_AI_MODEL: approvedWorkersAiModel,
                    }
                  ).fetch(new Request(command)),
              }),
            },
            KAPSO_API_KEY: "",
            KAPSO_WEBHOOK_SECRET: "",
            CLOUDFLARE_ACCESS_ISSUER: accessIssuer,
            CLOUDFLARE_ACCESS_AUDIENCE: accessAudience,
            WHATSAPP_BUSINESS_PORTFOLIO_ID: "",
          }),
      },
    });
  },
});

process.stdout.write(`Browser API ingress listening at ${server.url}\n`);
