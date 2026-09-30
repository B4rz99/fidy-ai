import { Clock, Effect, Option } from "effect";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import {
  UserTransactionCoordinator,
  makeCoreWorker,
  runBillingCollectionWorkflow,
} from "./browser-acceptance-core-module";
import { newId } from "./platform/operations";
import { db, firstCardUserId, fixtureUserId } from "./browser-acceptance-seed";
import {
  providerPrivateKey,
  providerPublicKey,
  providerResponse,
} from "./browser-acceptance-wompi";

const { makePublicWorker } = await import("./public-worker");
const { makeWorkerTelemetry } = await import("./runtime/telemetry");
const { browserOrigins } = await import("./runtime/topology");
const { approvedWorkersAiModel } = await import("@fidy/server/hosted-inference-model");

const certificate = Bun.env.PLAYWRIGHT_TLS_CERT;
const key = Bun.env.PLAYWRIGHT_TLS_KEY;
if (certificate === undefined || key === undefined) {
  throw new Error("Browser acceptance requires TLS certificate and key");
}

const accessIssuer = "https://acceptance.cloudflareaccess.com";
const accessAudience = "browser-acceptance-support";
const replacementCode = "ABCD-EFGH-JKLM-NPQR-STUV-WXYZ";
const replacementEmail = "nuevo@example.com";
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
