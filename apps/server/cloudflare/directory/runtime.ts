import { backgroundWorkAllowed, closedHostEnvironment } from "../release-isolation/operations";
import type { AcceptanceWindowBindings } from "../release-isolation/contract";
import { scopeDirectoryUrl } from "../erasure/contract";
import { providerAllowanceUrl } from "../resource-admission/contract";
import { admitSharedProvider } from "../resource-admission/operations";
import {
  cleanDirectoryCase,
  inspectDirectoryScope,
  outstandingDirectoryHandoffs,
  reconcileErasedHandoffs,
} from "./internal/erasure";
import {
  fenceErasureParticipant,
  handleSharedCleanup,
  participantDrain,
} from "../erasure-store/operations";
import {
  participantCleanupUrl,
  participantDrainedUrl,
  participantFenceUrl,
} from "../erasure-store/contract";
import { nativePATDirectoryUrl } from "../tokens/contract";
import { oauthRouteCommandUrl } from "../oauth-agents/contract";
import { routeSessionRequest } from "./operations";
import { oauthPaths } from "../../src/shell/oauth-agents/contract";
import { handleOAuthRouteCommand, publicOAuthRequest } from "../oauth-agents/operations";
import {
  PATRoute,
  SessionRoute,
  channelInspectUrl,
  directoryName,
  emailCapacityUrl,
  emailRouteUrl,
  externalLookupUrl,
  externalReserveUrl,
  handoffCancelUrl,
  handoffInspectUrl,
  mediaCapacityUrl,
  patRouteUrl,
  registerSessionUrl,
  rejectInvitationSendUrl,
  releaseSessionUrl,
  replaceIdentityUrl,
  reserveRecoveryUrl,
  rotateRecoveryRouteUrl,
  sessionRouteUrl,
  sourcePressureUrl,
  statusLookupAdmissionUrl,
  supportAdmissionUrl,
  supportApprovalUrl,
  whatsappBootstrapUrl,
  whatsappOwnerUrl,
} from "./contract";
import { directoryIdentityRequest, reconcileIdentityReplacements } from "./internal/replacement";

import { loginAllowanceUrl } from "../email-authentication/contract";
import { chargeLoginAttempt, directoryLoginEmail } from "./internal/login-email";
import { directorySupport } from "./internal/support";

import { recoveryRouteDecision } from "./internal/recovery-rotation";

import { ingestionCapacityRequest } from "./internal/email-capacity";
import { directoryDeadline, drainBootstrapExpiry } from "./internal/expiry";
import { unavailable } from "../browser-login/operations";
import { channelApprovalEvidence } from "./internal/channel";

import { externalEventRequest } from "./internal/external-events";
import { rejectInvitationSend, whatsappBootstrap, whatsappOwner } from "./internal/whatsapp";

import { admitBootstrap } from "./internal/admission";
import {
  cancelProviderHandoff,
  registerBrowserSession,
  registerRecoveryCredential,
  releaseBrowserSession,
} from "./internal/reservations";

import { inspectHandoff, providerRequest } from "./internal/provider";

import { ownsProviderAuthenticationPath } from "../provider-authentication/operations";
import type { ProviderConfiguration } from "../provider-authentication/contract";
import { OutboundHttpLive } from "../outbound-http/runtime";
import { FetchHttpClient, HttpClient } from "effect/http";
import { pollPairing, startPairing } from "./internal/pairing";
import { ownerCheckRequest, ownerCheckResponse } from "../maintenance/contract";
import {
  createStoreRuntime,
  observeStoreCheck,
  openSqliteStore,
  preserveStoreAlarm,
  storeReadiness,
  withStoreAdmission,
  withStoreCapacity,
} from "../runtime/sqlite/operations";
import {
  StoreCapacity,
  type StoreReleaseEnvironment,
  storeReadinessUrl,
} from "../runtime/sqlite/contract";

import { DurableObject } from "cloudflare:workers";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";

import { handlePATDirectoryCommand, nativePATPairing } from "../tokens/operations";
import { directoryHistory } from "./schema/operations";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { TokenShortId } from "../../src/core/tokens/contract";
import { canonicalRequestProtection } from "../canonical-admission/contract";

type DirectoryEnvironment = AcceptanceWindowBindings &
  StoreReleaseEnvironment &
  ProviderConfiguration &
  Readonly<{
    DIRECTORY: DurableObjectNamespace;
    USER_STORE: DurableObjectNamespace;
    ERASURE: DurableObjectNamespace;
  }>;

const digestBytes = 32;

const sourceExpiryPageSize = 32;

const admittedStatus = 204;

const pressureStatus = 429;

const admitUnresolved = Effect.fn(function* (source: string) {
  const sql = yield* SqliteClient;

  return yield* withStoreAdmission((admitGrowth) =>
    Effect.gen(function* () {
      const current = yield* Clock.currentTimeMillis;
      const { intervalMs, burst } = canonicalRequestProtection;
      yield* sql`DELETE FROM unresolved_source_buckets WHERE subject IN (SELECT subject FROM unresolved_source_buckets WHERE virtual_at_ms<=${current} ORDER BY virtual_at_ms LIMIT ${sourceExpiryPageSize})`;
      const retained = yield* sql`SELECT 1 FROM unresolved_source_buckets WHERE subject=${source}`;

      if (retained.length === 0) yield* admitGrowth;

      const rows = yield* sql`INSERT INTO unresolved_source_buckets(subject,virtual_at_ms)
            VALUES (${source},${current + intervalMs}) ON CONFLICT(subject) DO UPDATE
            SET virtual_at_ms=max(virtual_at_ms,${current})+${intervalMs}
            WHERE virtual_at_ms<=${current + (burst - 1) * intervalMs} RETURNING subject`;

      return new Response(null, {
        status: rows.length === 1 ? admittedStatus : pressureStatus,
      });
    })
  );
});

const inspectPressure = Effect.fnUntraced(function* (
  storage: DurableObjectStorage,
  drain: boolean
) {
  const sql = yield* SqliteClient;

  return yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;

      if (drain) {
        yield* drainBootstrapExpiry(now);
        yield* sql`DELETE FROM unresolved_source_buckets WHERE subject IN (SELECT subject FROM unresolved_source_buckets WHERE virtual_at_ms<=${now} ORDER BY virtual_at_ms LIMIT ${sourceExpiryPageSize})`;
      }

      const { deadline } = yield* directoryDeadline;

      if (Option.isNone(deadline)) return false;

      return yield* preserveStoreAlarm(storage, Math.max(deadline.value, now));
    })
  );
});

export class Directory extends DurableObject<DirectoryEnvironment> {
  private readonly runtime;
  constructor(state: DurableObjectState, env: DirectoryEnvironment) {
    super(state, env);
    this.runtime = createStoreRuntime({
      storage: state.storage,
      owner: "directory",
      ceilingBytes: env.SQLITE_STORE_CAPACITY_BYTES,
    });
    state.waitUntil(
      state.blockConcurrencyWhile(() =>
        this.runtime.runPromise(openSqliteStore(directoryHistory, env.CF_VERSION_METADATA.id))
      )
    );
  }
  override alarm(): Promise<void> {
    return this.runtime
      .runPromise(backgroundWorkAllowed(this.env))
      .then((allowed) => (allowed ? this.recoverAlarm() : undefined));
  }
  private recoverAlarm(): Promise<void> {
    return this.runtime.runPromise(
      Effect.andThen(
        Effect.andThen(
          reconcileErasedHandoffs(this.env.USER_STORE),
          reconcileIdentityReplacements(this.env.USER_STORE)
        ),
        inspectPressure(this.ctx.storage, true)
      ).pipe(Effect.asVoid)
    );
  }
  private erasure(request: Request): Promise<Response> {
    if (request.url === scopeDirectoryUrl) {
      return this.runtime.runPromise(
        inspectDirectoryScope(request, this.env.ERASURE).pipe(
          Effect.tapCause(() =>
            Effect.logWarning({
              component: "directory",
              operation: "inspectDirectoryScope",
              outcome: "unavailable",
            })
          ),
          Effect.catchCause(() => Effect.succeed(unavailable()))
        )
      );
    }

    if (request.url === participantCleanupUrl) {
      return this.runtime.runPromise(
        handleSharedCleanup(request, this.env.ERASURE, cleanDirectoryCase).pipe(
          Effect.tapCause(() =>
            Effect.logWarning({
              component: "directory",
              operation: "handleSharedCleanup",
              outcome: "unavailable",
            })
          ),
          Effect.catchCause(() => Effect.succeed(unavailable()))
        )
      );
    }

    if (request.url === participantDrainedUrl) {
      return this.runtime.runPromise(
        participantDrain(request, outstandingDirectoryHandoffs).pipe(
          Effect.tapCause(() =>
            Effect.logWarning({
              component: "directory",
              operation: "participantDrain",
              outcome: "unavailable",
            })
          ),
          Effect.catchCause(() => Effect.succeed(new Response(null, { status: 503 })))
        )
      );
    }

    {
      return this.runtime.runPromise(
        fenceErasureParticipant(request, this.env.USER_STORE, this.ctx.storage).pipe(
          Effect.tapCause(() =>
            Effect.logWarning({
              component: "directory",
              operation: "fenceErasureParticipant",
              outcome: "unavailable",
            })
          ),
          Effect.catchCause(() => Effect.succeed(unavailable()))
        )
      );
    }
  }
  override fetch(request: Request): Promise<Response> {
    if (!this.ctx.id.equals(this.env.DIRECTORY.idFromName(directoryName))) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }

    if (
      request.method === "POST" &&
      [
        scopeDirectoryUrl,
        participantCleanupUrl,
        participantDrainedUrl,
        participantFenceUrl,
      ].includes(request.url)
    ) {
      return this.erasure(request);
    }

    if (ownerCheckRequest(request)) {
      return this.runtime.runPromise(
        inspectPressure(this.ctx.storage, false).pipe(
          Effect.map(ownerCheckResponse),
          observeStoreCheck({
            storage: this.ctx.storage,
            history: directoryHistory,
            release: this.env.CF_VERSION_METADATA.id,
          })
        )
      );
    }

    return this.runtime.runPromise(
      (request.url === emailCapacityUrl || request.url === mediaCapacityUrl
        ? ingestionCapacityRequest(request, this.ctx.storage)
        : directoryRequest(
            request,
            closedHostEnvironment({ request, environment: this.env, boundary: "core" })
          )
      ).pipe(
        Effect.tapCause(() =>
          Effect.logWarning({
            component: "directory",
            operation: "directoryRequest",
            outcome: "unavailable",
          })
        ),
        Effect.catchCause(() => Effect.succeed(unavailable()))
      )
    );
  }
}

const credentialLookup = Effect.fn(function* (request: Request) {
  yield* (yield* StoreCapacity).observe;
  const sql = yield* SqliteClient;

  if (request.url === sourcePressureUrl) {
    const source = yield* Effect.tryPromise(() => request.text());

    if (!/^[0-9a-f]{64}$/u.test(source)) return new Response(null, { status: 400 });

    return yield* admitUnresolved(source);
  }

  if (request.url === patRouteUrl) {
    const shortId = yield* Schema.decodeEffect(TokenShortId)(
      yield* Effect.tryPromise(() => request.text())
    );

    const current = yield* Clock.currentTimeMillis;

    const [row] =
      yield* sql`SELECT user_id AS userId,pat_id AS patId FROM pat_routes WHERE short_id=${shortId} AND expires_at_ms>${current}`;

    return row === undefined
      ? new Response(null, { status: 404 })
      : Response.json(yield* Schema.decodeUnknownEffect(PATRoute)(row));
  }

  const digest = new Uint8Array(yield* Effect.tryPromise(() => request.arrayBuffer()));

  if (digest.byteLength !== digestBytes) return new Response(null, { status: 400 });

  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const current = yield* Clock.currentTimeMillis;

      const rows = yield* sql`SELECT user_id AS userId,session_id AS sessionId FROM session_routes
          WHERE token_digest=${digest} AND hard_expires_at_ms>${current}`;

      if (rows.length === 0) return new Response(null, { status: 404 });

      return Response.json(yield* Schema.decodeUnknownEffect(SessionRoute)(rows[0]));
    })
  );
});

const nativeProvider = Effect.fn(function* (request: Request, environment: DirectoryEnvironment) {
  const refusal = yield* admitBootstrap(request);

  if (Option.isSome(refusal)) return refusal.value;

  return yield* Effect.scoped(
    Effect.flatMap(Layer.build(OutboundHttpLive), (clients) =>
      providerRequest(request, environment).pipe(
        Effect.provideService(HttpClient.HttpClient, Context.get(clients, HttpClient.HttpClient))
      )
    )
  ).pipe(Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch));
});

const evidenceResponse = Effect.fn(function* (request: Request) {
  const id = yield* Effect.tryPromise(() => request.text());

  const evidence =
    request.url === handoffInspectUrl
      ? yield* inspectHandoff(id)
      : yield* channelApprovalEvidence(id);

  return evidence === null ? new Response(null, { status: 404 }) : Response.json(evidence);
});

const patPairingRequest = Effect.fn(function* (
  request: Request,
  environment: DirectoryEnvironment
) {
  const refusal = yield* admitBootstrap(request, "x-pat-source");

  if (Option.isSome(refusal)) return refusal.value;

  return yield* nativePATPairing({ request, users: environment.USER_STORE });
});

const pairRequest = Effect.fn(function* (request: Request, environment: DirectoryEnvironment) {
  const refusal = yield* admitBootstrap(request);

  if (Option.isSome(refusal)) return refusal.value;

  return yield* new URL(request.url).pathname === "/web/pairings"
    ? startPairing
    : pollPairing(request, environment.USER_STORE);
});

const routingCommands = new Map<
  string,
  | typeof handleOAuthRouteCommand
  | typeof handlePATDirectoryCommand
  | typeof releaseBrowserSession
  | typeof externalEventRequest
  | typeof credentialLookup
  | typeof rejectInvitationSend
  | typeof whatsappOwner
>([
  [releaseSessionUrl, releaseBrowserSession],
  [whatsappOwnerUrl, whatsappOwner],
  [rejectInvitationSendUrl, rejectInvitationSend],
  [sessionRouteUrl, credentialLookup],
  [sourcePressureUrl, credentialLookup],
  [patRouteUrl, credentialLookup],
  [oauthRouteCommandUrl, handleOAuthRouteCommand],
  [nativePATDirectoryUrl, handlePATDirectoryCommand],
  [statusLookupAdmissionUrl, externalEventRequest],
  [externalLookupUrl, externalEventRequest],
  [externalReserveUrl, externalEventRequest],
]);

const identityRequest = Effect.fn(function* (request: Request, environment: DirectoryEnvironment) {
  switch (request.url) {
    case providerAllowanceUrl:
      return yield* admitSharedProvider(request);
    case loginAllowanceUrl:
      return yield* chargeLoginAttempt;
    case replaceIdentityUrl:
    case emailRouteUrl:
      return yield* directoryIdentityRequest(request, environment.USER_STORE);
    case supportAdmissionUrl:
    case supportApprovalUrl:
      return yield* directorySupport(request, environment.USER_STORE);
    case rotateRecoveryRouteUrl:
      return yield* recoveryRouteDecision(request);
    default:
      return new Response(null, { status: 404 });
  }
});

const internalRequest = Effect.fn(function* (request: Request, environment: DirectoryEnvironment) {
  const routing = routingCommands.get(request.url);

  if (routing !== undefined) return yield* routing(request);

  switch (request.url) {
    case handoffInspectUrl:
    case channelInspectUrl:
      return yield* evidenceResponse(request);
    case registerSessionUrl:
      return yield* registerBrowserSession(request);
    case reserveRecoveryUrl:
      return yield* registerRecoveryCredential(request);
    case handoffCancelUrl:
      return yield* cancelProviderHandoff(
        yield* Effect.tryPromise(() => request.text()),
        environment.USER_STORE
      );

    case whatsappBootstrapUrl:
      return yield* whatsappBootstrap(request, environment.USER_STORE);
    default:
      return yield* identityRequest(request, environment);
  }
});

const isReadinessRequest = (request: Request): boolean =>
  request.method === "GET" && request.url === storeReadinessUrl;

const directoryRequest = Effect.fn(function* (request: Request, environment: DirectoryEnvironment) {
  if (isReadinessRequest(request)) {
    return yield* storeReadiness({
      history: directoryHistory,
      release: environment.CF_VERSION_METADATA.id,
    });
  }

  const path = new URL(request.url).pathname;

  if (Object.values(oauthPaths).some((candidate) => candidate === path)) {
    return yield* publicOAuthRequest({
      request,
      browserOrigin: environment.BROWSER_ORIGIN,
      environment,
      routeBrowser: () => routeSessionRequest({ request, environment }),
    });
  }

  if (ownsProviderAuthenticationPath(path)) return yield* nativeProvider(request, environment);

  if (request.method !== "POST") return new Response(null, { status: 404 });

  if (["/web/email/authentication/start", "/web/email/authentication/complete"].includes(path)) {
    return yield* directoryLoginEmail(request, environment.USER_STORE);
  }

  if (["/pat-pairings", "/pat-pairings/claim"].includes(path)) {
    return yield* patPairingRequest(request, environment);
  }

  if (["/web/pairings", "/web/pairings/redeem"].includes(path)) {
    return yield* pairRequest(request, environment);
  }

  return yield* internalRequest(request, environment);
});
