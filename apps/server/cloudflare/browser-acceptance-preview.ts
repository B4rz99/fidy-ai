import { captureWhatsApp, whatsappOperator } from "./browser-acceptance-whatsapp";
import { Clock, Effect, Option, Schema } from "effect";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import {
  UserTransactionCoordinator,
  makeCoreWorker,
  runBillingCollectionWorkflow,
} from "./browser-acceptance-core-module";
import { browserAcceptanceTopology } from "./browser-acceptance/operations";
import { newId } from "./secret-material/operations";
import { db, firstCardUserId, fixtureUserId, pairingUserId } from "./browser-acceptance-seed";
import { observeBrowserCost } from "./browser-cost/operations";
import {
  providerPrivateKey,
  providerPublicKey,
  providerResponse,
  syntheticDaviplataConfirmUrl,
  syntheticDaviplataSendUrl,
} from "./browser-acceptance-wompi";

const syntheticDaviplataBindings = {
  WOMPI_DAVIPLATA_OTP_SEND_URL: syntheticDaviplataSendUrl,
  WOMPI_DAVIPLATA_OTP_CONFIRM_URL: syntheticDaviplataConfirmUrl,
};

// Opt-in, loopback-only measurement; operator setup and background collection use the raw binding.
const browserCost =
  Bun.env.BROWSER_COST_MEASUREMENT === "1" ? Option.some(observeBrowserCost(db)) : Option.none();
const browserDatabase = Option.match(browserCost, {
  onNone: () => db,
  onSome: (observed) => observed.database,
});

const { makePublicWorker } = await import("./public-worker");
const { makeWorkerTelemetry } = await import("./runtime/telemetry/operations");
const { browserOrigins } = await import("./runtime/contract");
const { approvedWorkersAiModel } = await import("@fidy/server/hosted-inference-contract");

const certificate = Bun.env.PLAYWRIGHT_TLS_CERT;
const key = Bun.env.PLAYWRIGHT_TLS_KEY;
if (certificate === undefined || key === undefined) {
  throw new Error("Browser acceptance requires TLS certificate and key");
}

const selectedTopology = browserAcceptanceTopology();
const acceptanceMode = selectedTopology.mode;
const publicPort = selectedTopology.apiPort;
const operatorPort = selectedTopology.operatorPort;
const browserOrigin = browserOrigins.acceptance;
const isolatedBrowserOrigin = selectedTopology.app;
// Bridge only the isolated fixture's port identity; production origin policy stays unchanged.
const bridgeBrowserOrigin = (response: Response): Response => {
  if (
    acceptanceMode === "shared" ||
    response.headers.get("access-control-allow-origin") !== browserOrigin
  ) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", isolatedBrowserOrigin);
  return new Response(response.body, { status: response.status, headers });
};

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
const GoogleFixtureCode = Schema.fromJsonString(
  Schema.Struct({ nonce: Schema.String, subject: Schema.String })
);
const googleFixtureToken = (request: Request): Promise<Response> =>
  request.text().then((body) => {
    const code = new URLSearchParams(body).get("code") ?? "";
    const value = Schema.decodeSync(GoogleFixtureCode)(atob(code));
    return new SignJWT({ nonce: value.nonce, email: "google@example.test" })
      .setProtectedHeader({ alg: "RS256", kid: "acceptance-support" })
      .setIssuer("https://accounts.google.com")
      .setSubject(value.subject)
      .setAudience("acceptance-google")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey)
      .then((id_token) => Response.json({ id_token }));
  });
const microsoftFixtureToken = (request: Request): Promise<Response> =>
  request.text().then((body) => {
    const code = new URLSearchParams(body).get("code") ?? "";
    const value = Schema.decodeSync(GoogleFixtureCode)(atob(code));
    return new SignJWT({
      ver: "2.0",
      tid: "9188040d-6c67-4c5b-b112-36a304b66dad",
      nonce: value.nonce,
      email: "microsoft@example.test",
    })
      .setProtectedHeader({ alg: "RS256", kid: "acceptance-support" })
      .setIssuer("https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0")
      .setSubject(value.subject)
      .setAudience("acceptance-microsoft")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey)
      .then((id_token) => Response.json({ id_token }));
  });
const oidcFixtureResponse = ({
  url,
  args,
}: Readonly<{ url: string; args: Array<unknown> }>): Option.Option<Promise<Response>> => {
  if (url === "https://login.microsoftonline.com/common/discovery/v2.0/keys") {
    return Option.some(
      Promise.resolve(
        Response.json({
          keys: [{ ...jwk, issuer: "https://login.microsoftonline.com/{tenantid}/v2.0" }],
        })
      )
    );
  }
  if (url === "https://login.microsoftonline.com/common/oauth2/v2.0/token") {
    const outbound: unknown = Reflect.construct(Request, args);
    return Option.some(
      outbound instanceof Request
        ? microsoftFixtureToken(outbound)
        : Promise.resolve(new Response(null, { status: 400 }))
    );
  }
  if (url === "https://www.googleapis.com/oauth2/v3/certs") {
    return Option.some(Promise.resolve(Response.json({ keys: [jwk] })));
  }
  if (url === "https://oauth2.googleapis.com/token") {
    const outbound: unknown = Reflect.construct(Request, args);
    return Option.some(
      outbound instanceof Request
        ? googleFixtureToken(outbound)
        : Promise.resolve(new Response(null, { status: 400 }))
    );
  }
  return Option.none();
};
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply: (target, thisArg, args): unknown => {
    const requestUrl: unknown = args[0];
    const url = requestUrl instanceof Request ? requestUrl.url : String(requestUrl);
    if (url.startsWith("https://api.kapso.ai/meta/whatsapp/")) {
      const outbound: unknown = Reflect.construct(Request, args);
      return outbound instanceof Request
        ? captureWhatsApp(outbound)
        : Promise.resolve(new Response(null, { status: 400 }));
    }
    const oidc = oidcFixtureResponse({ url, args });
    if (Option.isSome(oidc)) return oidc.value;
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
              ...syntheticDaviplataBindings,
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
// Loopback-only metadata evidence for the native CLI journey, never public ingress.
const CliEvidence = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      operation: Schema.String,
      outcome: Schema.Literals(["accepted", "rejected"]),
      patId: Schema.String,
    })
  ),
});
const cliEvidence = (): Promise<Response> =>
  db
    .prepare(
      "SELECT operation, outcome, pat_id AS patId FROM pat_audit WHERE user_id = ? AND pat_id IS NOT NULL ORDER BY rowid DESC LIMIT 32"
    )
    .bind(fixtureUserId)
    .all()
    .then((rows) =>
      Response.json(Schema.decodeUnknownSync(CliEvidence)({ entries: rows.results }), {
        headers: { "cache-control": "no-store" },
      })
    );
const operatorSetup = (request: Request): Option.Option<Promise<Response>> => {
  if (Option.isSome(browserCost) && operatorRoute(request, "/browser-cost", "GET")) {
    return Option.some(
      Promise.resolve(
        Response.json(browserCost.value.cost(), {
          headers: { "cache-control": "no-store" },
        })
      )
    );
  }
  if (acceptanceMode === "cli" && operatorRoute(request, "/cli/evidence", "GET")) {
    return Option.some(cliEvidence());
  }
  // Loopback-only test setup for a fresh journey; never part of public ingress.
  if (operatorRoute(request, "/dashboard/reset", "POST")) {
    return Option.some(
      db
        .prepare("DELETE FROM dashboard_documents WHERE user_id = ?")
        .bind(firstCardUserId)
        .run()
        .then(() => new Response(null, { status: noContent }))
    );
  }
  return operatorRoute(request, "/billing/collect", "POST")
    ? Option.some(collectBilling())
    : Option.none();
};
const googleSubjectMaximumLength = 255;
const GoogleFixtureSubject = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(googleSubjectMaximumLength)
);
const googleOperator = (request: Request): Option.Option<Promise<Response>> => {
  const path = new URL(request.url).pathname;
  if (
    request.method !== "POST" ||
    ![
      "/google/expire",
      "/google/stale",
      "/google/revoke",
      "/microsoft/expire",
      "/microsoft/stale",
      "/microsoft/revoke",
    ].includes(path)
  ) {
    return Option.none();
  }
  const subject = Schema.decodeUnknownOption(GoogleFixtureSubject)(
    new URL(request.url).searchParams.get("subject")
  );
  if (Option.isNone(subject)) {
    return Option.some(Promise.resolve(new Response(null, { status: 400 })));
  }
  if (path.endsWith("/stale")) {
    return Option.some(
      db
        .prepare(
          "UPDATE web_sessions SET created_at_ms=created_at_ms-600001,fresh_until_ms=fresh_until_ms-600001,hard_expires_at_ms=hard_expires_at_ms-600001 WHERE user_id=(SELECT user_id FROM provider_credentials WHERE subject=?)"
        )
        .bind(subject.value)
        .run()
        .then(() => new Response(null, { status: 204 }))
    );
  }
  const statement = path.endsWith("/expire")
    ? db
        .prepare(
          "UPDATE web_sessions SET idle_expires_at_ms=created_at_ms WHERE user_id=(SELECT user_id FROM provider_credentials WHERE subject=?)"
        )
        .bind(subject.value)
    : db
        .prepare(`INSERT INTO consent_user_revocations(id,user_id,grant_record_id,session_id,occurred_at_ms)
        SELECT ?,c.user_id,g.id,w.id,? FROM provider_credentials c JOIN onboarding_consent_records g ON g.user_id=c.user_id JOIN web_sessions w ON w.user_id=c.user_id AND w.revoked_at_ms IS NULL WHERE c.subject=? ORDER BY w.created_at_ms DESC LIMIT 1`)
        .bind(newId(), Effect.runSync(Clock.currentTimeMillis), subject.value);
  return Option.some(statement.run().then(() => new Response(null, { status: 204 })));
};
const approvedFixtureUser = (parameters: URLSearchParams): string => {
  if (parameters.get("firstCard") === "true") return firstCardUserId;
  return parameters.get("pairing") === "true" ? pairingUserId : fixtureUserId;
};
const operator = Bun.serve({
  hostname: "127.0.0.1",
  port: operatorPort,
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
    const setup = Option.orElse(whatsappOperator(request), () =>
      Option.orElse(googleOperator(request), () => operatorSetup(request))
    );
    if (Option.isSome(setup)) return setup.value;
    const loginCode = operatorCode(request, "/email/login/deliver");
    if (Option.isSome(loginCode)) return deliverEmailLoginProof(loginCode.value);
    const approvalCode = operatorCode(request, "/approve");
    if (Option.isSome(approvalCode)) {
      const userId = approvedFixtureUser(new URL(request.url).searchParams);
      return approveWhatsAppPairing(approvalCode.value, userId);
    }
    return new Response(null, { status: 403 });
  },
});
process.stdout.write(`Browser approval fixture listening at ${operator.url}\n`);

const telemetry = makeWorkerTelemetry(() => undefined);
const core = makeCoreWorker(telemetry);
const worker = makePublicWorker(telemetry);
// Retain each fixture actor as Cloudflare does; resident MCP sessions span HTTP requests.
const coordinators = new Map<string, Pick<Fetcher, "fetch">>();
const coordinatorFor = (name: string): Pick<Fetcher, "fetch"> => {
  const existing = coordinators.get(name);
  if (existing !== undefined) return existing;
  const coordinator = new UserTransactionCoordinator(
    { id: { name }, storage: { setAlarm: (): Promise<void> => Promise.resolve() } },
    {
      DB: browserDatabase,
      AI: { run: (): Promise<never> => Promise.reject(new Error("unused")) },
      HOSTED_AI_MODEL: approvedWorkersAiModel,
    }
  );
  const fetcher = {
    fetch: (command: RequestInfo | URL): Promise<Response> =>
      coordinator.fetch(new Request(command)),
  };
  coordinators.set(name, fetcher);
  return fetcher;
};
const admissionKeyLength = 32;
const digestHexLength = 64;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: publicPort,
  tls: { cert: Bun.file(certificate), key: Bun.file(key) },
  fetch: (request) => {
    // Cloudflare supplies this header at the edge; never accept a client-provided value.
    const ingress = new Request(request);
    ingress.headers.set("cf-connecting-ip", "127.0.0.1");
    if (acceptanceMode !== "shared" && ingress.headers.get("origin") === isolatedBrowserOrigin) {
      ingress.headers.set("origin", browserOrigin);
    }
    return worker
      .fetch(ingress, {
        RELEASE_GIT_SHA: "browser-acceptance",
        BROWSER_ORIGIN: browserOrigin,
        LOCAL_CANONICAL_READ_BEARER: "",
        PAT_ADMISSION_KEY: "a".repeat(admissionKeyLength),
        CORE: {
          fetch: (forwarded) =>
            core.fetch(new Request(forwarded), {
              DB: browserDatabase,
              AI: { run: () => Promise.reject(new Error("unused")) },
              CONTRACT_DIGEST: "a".repeat(digestHexLength),
              RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
              HOSTED_AI_MODEL: approvedWorkersAiModel,
              BROWSER_ORIGIN: browserOrigin,
              MICROSOFT_CLIENT_ID: "acceptance-microsoft",
              MICROSOFT_CLIENT_SECRET: "synthetic-microsoft-secret",
              MICROSOFT_REDIRECT_URI: "https://127.0.0.1:4174/providers/microsoft/callback",
              GOOGLE_CLIENT_ID: "acceptance-google",
              GOOGLE_CLIENT_SECRET: "synthetic-google-secret",
              GOOGLE_REDIRECT_URI: "https://127.0.0.1:4174/providers/google/callback",
              WOMPI_ENVIRONMENT: "sandbox",
              WOMPI_PUBLIC_KEY: providerPublicKey,
              WOMPI_PRIVATE_KEY: providerPrivateKey,
              WOMPI_INTEGRITY_SECRET: `test_integrity_${"f1d7c0de".repeat(3)}`,
              ...syntheticDaviplataBindings,
              USER_TRANSACTION_COORDINATOR: {
                getByName: coordinatorFor,
              },
              KAPSO_API_KEY: "acceptance-kapso-key",
              WHATSAPP_SANDBOX_PHONE_NUMBER_ID: "",
              KAPSO_WEBHOOK_SECRET: "acceptance-kapso-secret",
              CLOUDFLARE_ACCESS_ISSUER: accessIssuer,
              CLOUDFLARE_ACCESS_AUDIENCE: accessAudience,
              WHATSAPP_BUSINESS_PORTFOLIO_ID: "portfolio",
            }),
        },
      })
      .then(bridgeBrowserOrigin);
  },
});

process.stdout.write(`Browser API ingress listening at ${server.url}\n`);
