import { makeWorkerCrypto } from "../secret-material/runtime";
import {
  bancolombiaSandboxAdmission,
  makeBancolombiaSandboxActivation,
  makeBancolombiaSandboxPreparation,
} from "../bancolombia-authentication/runtime";
import type { BancolombiaSandboxEnvironment } from "../bancolombia-authentication/contract";
import {
  ConnectionActivation,
  ConnectionBank,
  type ConnectionBankActivation,
  type ConnectionBankPreparation,
  ConnectionGrantKey,
  ConnectionSandboxAdmission,
} from "../connections/contract";
import {
  ConnectionInstitutions,
  registeredConnectionInstitutionIds,
} from "../../src/shell/connections/contract";
import { withErasureRecovery } from "../erasure/runtime";
import { ErasureUnavailable } from "../erasure-store/contract";
import {
  executeErasureAdmission,
  executeErasureContinuation,
  executeErasureControl,
  executeErasureRestore,
} from "../erasure/operations";
import { makeAuditErasureStores } from "../audit/runtime";
import { makeBrowserLoginErasureStores } from "../browser-login/runtime";
import { makeBudgetsErasureStores } from "../budgets/runtime";
import { makeCanonicalAdmissionErasureStores } from "../canonical-admission/runtime";
import { makeCategoriesErasureStores } from "../categories/runtime";
import { makeConnectionsErasureStores } from "../connections/runtime";
import { makeConsentErasureStores } from "../consent/runtime";
import { makeDashboardErasureStores } from "../dashboard/runtime";
import { makeEmailAuthenticationErasureStores } from "../email-authentication/runtime";
import { makeIdentityErasureStores } from "../identity/runtime";
import { makeIngestionErasureStores } from "../ingestion/runtime";
import { makeMemoryErasureStores } from "../memory/runtime";
import { makeOauthAgentsErasureStores } from "../oauth-agents/runtime";
import { makeOauthConfirmationErasureStores } from "../oauth-confirmation/runtime";
import { makeProviderAuthenticationErasureStores } from "../provider-authentication/runtime";
import { makeQuotasErasureStores } from "../quotas/runtime";
import { makeRecoveryErasureStores } from "../recovery/runtime";
import { makeRecurringPlansErasureStores } from "../recurring-plans/runtime";
import { makeRecurringErasureStores } from "../recurring/runtime";
import { makeResourceAdmissionErasureStores } from "../resource-admission/runtime";
import { makeSubscriptionErasureStores } from "../subscription/runtime";
import { makeTokensErasureStores } from "../tokens/runtime";
import { makeWebSessionErasureStores } from "../web-session/runtime";
import { makeWhatsappErasureStores } from "../whatsapp/runtime";
import { projections as erasureProjections } from "./internal/erasure";
import { makeErasureOriginals, makeErasureStore } from "../erasure-store/runtime";
import type { ErasureStore } from "../erasure-store/contract";
import { decodeTraceParent } from "../../src/shell/observability/operations";
import { workerInternalTraceHeader } from "../runtime/telemetry/contract";
import { executeConsentRenewal, executeConsentWithdrawal } from "../consent/operations";
import {
  executeConnectionBrowserAdmission,
  executeConnectionCallbackAdmission,
} from "../connections/operations";
import {
  executeRefundSupportAdmission,
  executeSubscriptionRenewalAdmission,
} from "../subscription/operations";
import { ProactivityActivity, type ProactivityEnvironment } from "../insights/contract";
import { executeProactivityWork, makeInsightsErasureStores } from "../insights/runtime";
import { RecurringWork } from "../recurring/contract";
import { evaluateRecurringSeries } from "../recurring/operations";
import { makeAgentErasureStores, makeAgentService } from "../agent/runtime";
import { repairDashboardProjections as ownerRepairDashboardProjections } from "./internal/dashboard-repair";
import { CanonicalWorkAdmission } from "../canonical-operations/contract";
import {
  canonicalWorkRequiresInference,
  executeCanonicalWork,
  executeOAuthCanonicalWork,
} from "../canonical-operations/operations";
import { OAuthCanonicalAdmission } from "../../src/shell/mcp/contract";
import { OAuthMcpAdmission } from "../mcp/contract";
import { type McpResidency, makeMcpResidency } from "../mcp/runtime";
import { OAuthRefreshAdmission, OAuthRevocationAdmission } from "../oauth-agents/contract";
import { executeOAuthRefresh, executeOAuthRevocation } from "../oauth-agents/operations";
import type { HostedCommitFence } from "../agent/contract";
import { UserId } from "../../src/core/identity/contract";

import {
  Clock,
  Crypto,
  Data,
  DateTime,
  Effect,
  Exit,
  Option,
  Redacted,
  Schema,
  type Scope,
} from "effect";

import { optionalHostedInference } from "../ai/runtime";
import type { WorkersAiEnvironment } from "../ai/contract";
import { type TransactionCaller, transactionUnavailable } from "../canonical-work/operations";
import { ForwardedEmailWork, StatementCoordinatorActivity } from "../ingestion/contract";
import {
  failStatementSubmission,
  processForwardedEmail,
  processStatementSubmission,
} from "../ingestion/operations";

import { coordinatorProbeName } from "../runtime/operational-health/contract";
import {
  cloudflareWorkerTelemetry,
  observeWorkerPromise,
  observeWorkerRequest,
  workerRelease,
} from "../runtime/telemetry/operations";

const digestBytes = 32;
const HTTP_OK = 200;
const HTTP_ACCEPTED = 202;
class EmailActivityUnavailable extends Data.TaggedError("EmailActivityUnavailable") {}
const httpServiceUnavailable = 503;
/** Rebuild the exact live subject the work admission was issued for. */
const admissionSubject = (admission: CanonicalWorkAdmission): TransactionCaller =>
  admission._tag === "PATWork"
    ? {
        patId: admission.patId,
        userId: admission.userId,
        digest: new Uint8Array(admission.digest),
        requiredScope: Option.fromNullishOr(admission.requiredScope),
      }
    : {
        id: admission.sessionId,
        userId: admission.userId,
        digest: new Uint8Array(admission.digest),
      };

/**
 * The coordination authority's dependencies: the D1 database it commits through, plus the hosted
 * inference bindings the Memory owner's capacity policy needs. Only Memory work reads them, so an
 * unusable binding denies that owner alone and every other owner decides without it.
 */
type CoordinatorEnvironment = Readonly<{
  DB: D1Database;
}> &
  /** Native optional binding, normalized to Option when work enters the application. */
  Partial<
    Readonly<{
      ERASURE_BUCKET: R2Bucket;
      ERASURE_REQUIRED: string;
      STATEMENT_STAGING_BUCKET: R2Bucket;
      EMAIL_BUCKET: R2Bucket;
      KAPSO_API_KEY: string;
      WHATSAPP_SANDBOX_PHONE_NUMBER_ID: string;
      WOMPI_ENVIRONMENT: string;
    }>
  > &
  WorkersAiEnvironment &
  ProactivityEnvironment &
  BancolombiaSandboxEnvironment;

const executeStatementActivity = (
  activity: typeof StatementCoordinatorActivity.Type,
  environment: CoordinatorEnvironment,
  userId: string
): Effect.Effect<Response> => {
  const { submissionId } = activity;
  const request = Effect.gen(function* () {
    if (activity._tag === "StatementFailed") {
      yield* failStatementSubmission({
        DB: environment.DB,
        userId,
        submissionId,
        reason: "resource-limit",
      });
      return HTTP_OK;
    }
    if (environment.STATEMENT_STAGING_BUCKET === undefined) return httpServiceUnavailable;
    const progress = yield* processStatementSubmission({
      DB: environment.DB,
      STATEMENT_STAGING_BUCKET: environment.STATEMENT_STAGING_BUCKET,
      userId,
      submissionId,
    });
    return progress === "continue" ? HTTP_ACCEPTED : HTTP_OK;
  });
  return request.pipe(
    Effect.map((status) => new Response(null, { status })),
    Effect.orElseSucceed(transactionUnavailable)
  );
};

const authorizedStatementActivity = (
  candidate: unknown,
  userId: string
): Option.Option<typeof StatementCoordinatorActivity.Type> =>
  Schema.decodeUnknownOption(StatementCoordinatorActivity)(candidate).pipe(
    Option.filter((activity) => activity.userId === userId)
  );

const executeCanonicalAdmission = (
  admission: CanonicalWorkAdmission,
  environment: CoordinatorEnvironment,
  hostedFence: Option.Option<HostedCommitFence>
): Effect.Effect<Response, never, Scope.Scope> =>
  Effect.gen(function* () {
    const inference = canonicalWorkRequiresInference(admission.work)
      ? yield* optionalHostedInference({
          environment,
          db: environment.DB,
          userId: admission.userId,
          admittedTurnId: () => Option.map(hostedFence, ({ turnId }) => turnId),
        })
      : Option.none();
    return yield* executeCanonicalWork({
      db: environment.DB,
      work: admission.work,
      subject: admissionSubject(admission),
      current: yield* Clock.currentTimeMillis,
      bucket: Option.fromUndefinedOr(environment.STATEMENT_STAGING_BUCKET),
      hostedFence,
      inference,
      oauthConfirmation: Option.none(),
    });
  });

const executeForwardedEmailActivity = (
  candidate: unknown,
  environment: CoordinatorEnvironment,
  userId: string
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const work = Schema.decodeUnknownOption(ForwardedEmailWork)(candidate);
    const bucket = environment.EMAIL_BUCKET;
    if (Option.isNone(work) || work.value.userId !== userId || bucket === undefined) {
      return transactionUnavailable();
    }
    const completed = yield* Effect.exit(
      Effect.tryPromise({
        try: () =>
          processForwardedEmail({
            DB: environment.DB,
            EMAIL_BUCKET: { get: (key) => bucket.get(key).then(Option.fromNullishOr) },
            userId,
            receiptId: work.value.receiptId,
          }),
        catch: () => new EmailActivityUnavailable(),
      }).pipe(Effect.withSpan("ingestion.forwarded-email.process"))
    );
    return Exit.isFailure(completed)
      ? transactionUnavailable()
      : new Response(null, { status: HTTP_OK });
  });

const privateRecurringActivity = ({
  request,
  candidate,
  environment,
  userId,
}: Readonly<{
  request: Request;
  candidate: unknown;
  environment: CoordinatorEnvironment;
  userId: string;
}>): Option.Option<Effect.Effect<Response>> => {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/recurring-work") {
    return Option.none();
  }
  const work = Schema.decodeUnknownOption(RecurringWork)(candidate);
  if (Option.isNone(work) || work.value.userId !== userId) {
    return Option.some(Effect.succeed(transactionUnavailable()));
  }
  return Option.some(
    evaluateRecurringSeries({ db: environment.DB, userId: work.value.userId }).pipe(
      Effect.map(() => new Response(null, { status: HTTP_OK })),
      Effect.orElseSucceed(transactionUnavailable)
    )
  );
};
const privateIngestionActivity = ({
  request,
  candidate,
  environment,
  userId,
}: Readonly<{
  request: Request;
  candidate: unknown;
  environment: CoordinatorEnvironment;
  userId: string;
}>): Option.Option<Effect.Effect<Response>> => {
  if (request.method !== "POST") return Option.none();
  const path = new URL(request.url).pathname;
  if (path === "/forwarded-email-work") {
    return Option.some(executeForwardedEmailActivity(candidate, environment, userId));
  }
  if (path !== "/statement-work") return Option.none();
  const activity = authorizedStatementActivity(candidate, userId);
  return Option.some(
    Option.isNone(activity)
      ? Effect.succeed(transactionUnavailable())
      : executeStatementActivity(activity.value, environment, userId)
  );
};

type OAuthActivityInput = Readonly<{
  request: Request;
  candidate: unknown;
  environment: CoordinatorEnvironment;
  userId: string;
}>;
const privateOAuthRevocation = (input: OAuthActivityInput): Effect.Effect<Response> => {
  const revocation = Schema.decodeUnknownOption(OAuthRevocationAdmission)(input.candidate);
  return Option.isNone(revocation) || revocation.value.userId !== input.userId
    ? Effect.succeed(transactionUnavailable())
    : executeOAuthRevocation({
        db: input.environment.DB,
        admission: revocation.value,
        signal: input.request.signal,
      });
};
const privateOAuthActivity = (
  input: OAuthActivityInput
): Option.Option<Effect.Effect<Response, never, Scope.Scope>> => {
  const path = new URL(input.request.url).pathname;
  if (path === "/oauth-revoke") {
    return Option.some(privateOAuthRevocation(input));
  }
  if (path === "/oauth-refresh") {
    const refresh = Schema.decodeUnknownOption(OAuthRefreshAdmission)(input.candidate);
    return Option.some(
      Option.isNone(refresh) || refresh.value.userId !== input.userId
        ? Effect.succeed(transactionUnavailable())
        : executeOAuthRefresh({
            db: input.environment.DB,
            admission: refresh.value,
            signal: input.request.signal,
          })
    );
  }
  return path === "/oauth-canonical"
    ? Option.some(privateOAuthCanonicalWork(input))
    : Option.none();
};
const privateOAuthCanonicalWork = (
  input: OAuthActivityInput
): Effect.Effect<Response, never, Scope.Scope> => {
  const oauth = Schema.decodeUnknownOption(OAuthCanonicalAdmission)(input.candidate);
  if (Option.isNone(oauth) || oauth.value.userId !== input.userId) {
    return Effect.succeed(transactionUnavailable());
  }
  const admitted = oauth.value;
  return Effect.gen(function* () {
    if (
      input.request.signal.aborted ||
      (yield* Clock.currentTimeMillis) >= admitted.deadlineMilliseconds
    ) {
      return transactionUnavailable();
    }
    const inference = yield* optionalHostedInference({
      environment: input.environment,
      db: input.environment.DB,
      userId: admitted.userId,
      admittedTurnId: () => Option.none(),
    });
    return yield* executeOAuthCanonicalWork({
      db: input.environment.DB,
      signal: input.request.signal,
      deadlineMilliseconds: admitted.deadlineMilliseconds,
      operation: admitted.operation,
      input: admitted.input,
      confirmation: Option.fromUndefinedOr(admitted.confirmation),
      retryKey: Option.fromUndefinedOr(admitted.retryKey),
      bucket: Option.fromUndefinedOr(input.environment.STATEMENT_STAGING_BUCKET),
      inference,
      subject: {
        userId: admitted.userId,
        oauthConnectionId: admitted.connectionId,
        credentialId: admitted.credentialId,
        clientId: admitted.clientId,
        resource: admitted.resource,
        digest: new Uint8Array(admitted.digest),
        requiredScope: Option.none(),
      },
    });
  });
};
const privateProactivityActivity = (
  input: Readonly<{
    request: Request;
    candidate: unknown;
    environment: CoordinatorEnvironment;
    userId: string;
  }>
): Option.Option<Effect.Effect<Response>> => {
  if (
    input.request.method !== "POST" ||
    new URL(input.request.url).pathname !== "/proactivity-work"
  ) {
    return Option.none();
  }
  const work = Schema.decodeUnknownOption(ProactivityActivity)(input.candidate);
  if (Option.isNone(work) || work.value.userId !== input.userId) {
    return Option.some(Effect.succeed(transactionUnavailable()));
  }
  return Option.some(
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        executeProactivityWork({
          environment: input.environment,
          userId: UserId.make(input.userId),
          work: work.value,
          now,
        })
      ),
      Effect.map((result) => Response.json(result, { headers: { "cache-control": "no-store" } })),
      Effect.orElseSucceed(transactionUnavailable)
    )
  );
};

const privateConnectionActivity = (
  input: OAuthActivityInput
): Option.Option<Effect.Effect<Response>> => {
  if (
    input.request.method !== "POST" ||
    !["/connection-begin", "/connection-callback"].includes(new URL(input.request.url).pathname)
  ) {
    return Option.none();
  }
  return Option.some(
    (new URL(input.request.url).pathname === "/connection-callback"
      ? executeConnectionCallbackAdmission
      : executeConnectionBrowserAdmission)({
      db: input.environment.DB,
      candidate: input.candidate,
      userId: input.userId,
      signal: input.request.signal,
    }).pipe(Effect.provideService(Crypto.Crypto, makeWorkerCrypto()))
  );
};
const consentActivities = new Map([
  ["/consent-renew", executeConsentRenewal],
  ["/consent-withdraw", executeConsentWithdrawal],
]);
const privateErasureActivity = (
  input: Parameters<typeof privateProactivityActivity>[0] &
    Readonly<{
      clearCoordinator: () => Effect.Effect<boolean, ErasureUnavailable>;
    }>
): Option.Option<Effect.Effect<Response>> => {
  if (input.request.method !== "POST") return Option.none();
  const restore = privateErasureRestore(input);
  if (Option.isSome(restore)) return restore;
  const erasurePath = new URL(input.request.url).pathname;
  if (erasurePath === "/erasure-admit") {
    return Option.some(
      executeErasureAdmission({
        db: input.environment.DB,
        userId: input.userId,
        candidate: input.candidate,
        signal: input.request.signal,
        stores: erasureStores(input.environment.DB),
        recovery: {
          db: input.environment.DB,
          bucket: Option.fromUndefinedOr(input.environment.ERASURE_BUCKET),
        },
      })
    );
  }
  if (erasurePath === "/erasure-continue") {
    return Option.some(
      executeErasureContinuation({
        db: input.environment.DB,
        userId: input.userId,
        candidate: input.candidate,
        stores: erasureStores(input.environment.DB),
        originals: makeErasureOriginals({
          db: input.environment.DB,
          email: Option.fromUndefinedOr(input.environment.EMAIL_BUCKET),
          statement: Option.fromUndefinedOr(input.environment.STATEMENT_STAGING_BUCKET),
          registry: Option.fromUndefinedOr(input.environment.ERASURE_BUCKET),
        }),
        recovery: {
          db: input.environment.DB,
          bucket: Option.fromUndefinedOr(input.environment.ERASURE_BUCKET),
        },
        clearCoordinator: input.clearCoordinator,
      })
    );
  }
  if (["/erasure-receipt", "/erasure-custody-evidence"].includes(erasurePath)) {
    return Option.some(
      executeErasureControl({
        db: input.environment.DB,
        userId: input.userId,
        candidate: input.candidate,
        operation: erasurePath === "/erasure-receipt" ? "Receipt" : "CustodyEvidence",
        stores: erasureStores(input.environment.DB),
      })
    );
  }
  return Option.none();
};
const privateErasureRestore = (
  input: Parameters<typeof privateProactivityActivity>[0]
): Option.Option<Effect.Effect<Response>> => {
  const erasurePath = new URL(input.request.url).pathname;
  if (input.request.method === "POST" && erasurePath === "/erasure-restore") {
    return Option.some(
      executeErasureRestore({
        db: input.environment.DB,
        userId: input.userId,
        candidate: input.candidate,
        stores: erasureStores(input.environment.DB),
        recovery: {
          db: input.environment.DB,
          bucket: Option.fromUndefinedOr(input.environment.ERASURE_BUCKET),
        },
      })
    );
  }
  return Option.none();
};

const privateOwnerActivity = (
  input: Parameters<typeof privateProactivityActivity>[0]
): Option.Option<Effect.Effect<Response>> => {
  if (
    input.request.method === "POST" &&
    new URL(input.request.url).pathname === "/subscription-renewal-work"
  ) {
    return Option.some(
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          executeSubscriptionRenewalAdmission({
            db: input.environment.DB,
            userId: input.userId,
            candidate: input.candidate,
            environment: input.environment.WOMPI_ENVIRONMENT ?? "",
            now,
          })
        )
      )
    );
  }
  if (
    input.request.method === "POST" &&
    new URL(input.request.url).pathname === "/billing-refund-work"
  ) {
    return Option.some(
      executeRefundSupportAdmission({
        db: input.environment.DB,
        userId: input.userId,
        candidate: input.candidate,
        environment: input.environment.WOMPI_ENVIRONMENT ?? "",
      })
    );
  }
  const consentActivity = consentActivities.get(new URL(input.request.url).pathname);
  if (input.request.method === "POST" && consentActivity !== undefined) {
    return Option.some(
      consentActivity({
        db: input.environment.DB,
        candidate: input.candidate,
        userId: input.userId,
        signal: input.request.signal,
      })
    );
  }
  return privateConnectionActivity(input).pipe(
    Option.orElse(() => privateProactivityActivity(input)),
    Option.orElse(() => privateRecurringActivity(input)),
    Option.orElse(() => privateIngestionActivity(input))
  );
};

const reservedCoordinatorProbe = ({
  db,
  userId,
  path,
  method,
}: Readonly<{
  db: D1Database;
  userId: string;
  path: string;
  method: string;
}>): Option.Option<Promise<Response>> => {
  if (path === "/operational/probe" && userId === coordinatorProbeName) {
    return Option.some(
      db
        .prepare("SELECT 1 AS usable")
        .first()
        .then(
          () => new Response(null, { status: 204 }),
          () => new Response(null, { status: 503 })
        )
    );
  }
  if (userId !== "_release-smoke-v1") return Option.none();
  return Option.some(
    Promise.resolve(
      path === "/release-smoke" && method === "GET"
        ? Response.json({ status: "compatible" })
        : Response.json({}, { status: 404 })
    )
  );
};

/** Restore private correlation inside the Effect fiber that owns the coordinator work. */
const observeCoordinatorRequest = <E, R>(
  work: Effect.Effect<Response, E, R>,
  request: Request,
  environment: CoordinatorEnvironment
): Effect.Effect<Response, E, R> =>
  Effect.flatMap(Clock.currentTimeMillis, (receivedAtUnixMilliseconds) =>
    observeWorkerRequest(work, {
      environment: workerRelease(environment),
      telemetry: cloudflareWorkerTelemetry,
      operation: "worker.core.coordinator",
      parent: Option.getOrUndefined(
        decodeTraceParent({
          value: Option.fromNullOr(request.headers.get(workerInternalTraceHeader)),
          receivedAtUnixMilliseconds,
        })
      ),
    })
  );

/** One instance per stable User coordinates mutations; D1 alone owns the FinancialRecord. */
const executeMcpProtocolAdmission = (
  mcp: McpResidency,
  request: Request,
  { userId, environment }: Readonly<{ userId: string; environment: CoordinatorEnvironment }>
): Promise<Response> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const candidate = yield* Effect.option(Effect.tryPromise(() => request.json()));
        if (Option.isNone(candidate)) return transactionUnavailable();
        const admission = Schema.decodeUnknownOption(OAuthMcpAdmission)(candidate.value);
        if (Option.isNone(admission) || admission.value.userId !== userId) {
          return transactionUnavailable();
        }
        return yield* mcp.handle({ admission: admission.value, signal: request.signal });
      })
    ).pipe((work) => observeCoordinatorRequest(work, request, environment))
  );
const executeResidentOAuthActivity = (
  input: OAuthActivityInput,
  mcp: McpResidency,
  activity: Effect.Effect<Response, never, Scope.Scope>
): Effect.Effect<Response, never, Scope.Scope> =>
  Effect.gen(function* () {
    const response = yield* activity;
    if (new URL(input.request.url).pathname !== "/oauth-revoke" || !response.ok) return response;
    const revoked = Schema.decodeUnknownOption(OAuthRevocationAdmission)(input.candidate);
    if (Option.isSome(revoked) && revoked.value.userId === input.userId) {
      yield* mcp.retireConnections(revoked.value.connectionId);
    }
    return response;
  });
export class UserTransactionCoordinator {
  private pending: Promise<void> = Promise.resolve();
  private readonly state: Readonly<{
    id: Readonly<{ name: string }>;
    storage: Pick<DurableObjectStorage, "setAlarm" | "deleteAlarm" | "getAlarm">;
  }>;
  private readonly env: CoordinatorEnvironment;
  private readonly erasureEnvironment: CoordinatorEnvironment;
  private readonly mcp: McpResidency;
  private readonly institutions: typeof registeredConnectionInstitutionIds;
  private readonly bank: Option.Option<ConnectionBankPreparation>;
  private readonly activation: Option.Option<ConnectionBankActivation>;
  constructor(
    state: Readonly<{
      id: Readonly<{ name: string }>;
      storage: Pick<DurableObjectStorage, "setAlarm" | "deleteAlarm" | "getAlarm">;
    }>,
    env: CoordinatorEnvironment,
    configuration: Readonly<{
      institutions: typeof registeredConnectionInstitutionIds;
      bank: Option.Option<ConnectionBankPreparation>;
      activation: Option.Option<ConnectionBankActivation>;
    }> = {
      institutions: registeredConnectionInstitutionIds,
      bank: Option.none(),
      activation: Option.none(),
    }
  ) {
    this.state = state;
    this.institutions = configuration.institutions;
    this.bank = Option.orElse(configuration.bank, () =>
      makeBancolombiaSandboxPreparation({ environment: env, userId: state.id.name })
    );
    this.activation = Option.orElse(configuration.activation, () =>
      makeBancolombiaSandboxActivation({ environment: env, userId: state.id.name })
    );
    this.erasureEnvironment = env;
    this.env = withErasureRecovery(env);
    this.mcp = makeMcpResidency({
      userId: state.id.name,
      db: this.env.DB,
      enqueueCanonicalWork: (input) => this.enqueueOAuthCanonicalWork(input),
    });
  }

  /** Compose one canonical ticket on the callback fiber, including predecessor and native settlement. */
  private enqueueOAuthCanonicalWork(
    input: Readonly<{ admission: OAuthCanonicalAdmission; signal: AbortSignal }>
  ): Effect.Effect<Response> {
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        const preceding = this.pending;
        const settled = Promise.withResolvers<void>();
        this.pending = settled.promise;
        return { preceding, settled };
      }),
      ({ preceding }) =>
        Effect.tryPromise(() => preceding).pipe(
          Effect.orDie,
          Effect.andThen(
            Effect.scoped(
              privateOAuthCanonicalWork({
                request: new Request("https://coordinator.internal/oauth-canonical", {
                  method: "POST",
                  signal: input.signal,
                }),
                candidate: input.admission,
                environment: this.env,
                userId: this.state.id.name,
              })
            )
          )
        ),
      ({ preceding, settled }) =>
        Effect.tryPromise(() => preceding).pipe(
          Effect.orDie,
          Effect.ensuring(Effect.sync(settled.resolve))
        )
    );
  }

  fetch(request: Request): Promise<Response> {
    const environment = this.env;
    const userId = this.state.id.name;
    const path = new URL(request.url).pathname;
    const probe = reservedCoordinatorProbe({
      db: environment.DB,
      userId,
      path,
      method: request.method,
    });
    if (Option.isSome(probe)) return probe.value;
    if (path === "/oauth-mcp") {
      const mcp = this.mcp;
      return executeMcpProtocolAdmission(mcp, request, { userId, environment });
    }
    const hosted = makeAgentService({
      environment,
      userId: UserId.make(userId),
      scheduleRecovery: (due) => this.state.storage.setAlarm(due),
      connectionAdmission: bancolombiaSandboxAdmission(environment),
    }).accept({ request, preceding: this.pending });
    if (Option.isSome(hosted)) {
      this.pending = hosted.value.settled;
      return hosted.value.response;
    }
    const prior = this.pending;
    const response = prior.then(() => this.runCoordinatedRequest({ request, userId }));
    this.pending = response.then(
      () => undefined,
      () => undefined
    );
    return response;
  }

  private clearErasureCoordinator(): Effect.Effect<boolean, ErasureUnavailable> {
    const storage = this.state.storage;
    const mcp = this.mcp;
    return Effect.gen(function* () {
      yield* mcp.retireConnections(Option.none());
      if (!(yield* mcp.erasureSettled())) return false;
      yield* Effect.tryPromise({
        try: () => storage.deleteAlarm(),
        catch: () => new ErasureUnavailable(),
      });
      return (
        (yield* Effect.tryPromise({
          try: () => storage.getAlarm(),
          catch: () => new ErasureUnavailable(),
        })) === null
      );
    });
  }

  private runCoordinatedRequest(
    input: Readonly<{
      request: Request;
      userId: string;
    }>
  ): Promise<Response> {
    const { request, userId } = input;
    const { env: environment, mcp, erasureEnvironment } = this;
    const clearCoordinator = this.clearErasureCoordinator.bind(this);
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const candidate = yield* Effect.option(Effect.tryPromise(() => request.json()));
          if (Option.isNone(candidate)) return transactionUnavailable();
          const erasure = privateErasureActivity({
            request,
            candidate: candidate.value,
            environment: erasureEnvironment,
            userId,
            clearCoordinator,
          });
          if (Option.isSome(erasure)) return yield* erasure.value;
          const owner = privateOwnerActivity({
            request,
            candidate: candidate.value,
            environment,
            userId,
          });
          if (Option.isSome(owner)) return yield* owner.value;
          const oauth = privateOAuthActivity({
            request,
            candidate: candidate.value,
            environment,
            userId,
          });
          if (Option.isSome(oauth)) {
            return yield* executeResidentOAuthActivity(
              { request, candidate: candidate.value, environment, userId },
              mcp,
              oauth.value
            );
          }
          const admission = Schema.decodeUnknownOption(CanonicalWorkAdmission)(candidate.value);
          if (
            Option.isNone(admission) ||
            admission.value.digest.length !== digestBytes ||
            admission.value.userId !== userId
          ) {
            return transactionUnavailable();
          }
          return yield* executeCanonicalAdmission(admission.value, environment, Option.none());
        })
      ).pipe(
        (work) => this.withConnectionContext(work),
        (work) => observeCoordinatorRequest(work, request, environment)
      )
    );
  }

  private withConnectionContext<A, E>(work: Effect.Effect<A, E>): Effect.Effect<A, E> {
    return work.pipe(
      Effect.provideService(ConnectionInstitutions, this.institutions),
      Effect.provideService(ConnectionSandboxAdmission, bancolombiaSandboxAdmission(this.env)),
      Effect.provideService(ConnectionBank, this.bank),
      Effect.provideService(ConnectionActivation, this.activation),
      Effect.provideService(
        ConnectionGrantKey,
        Option.map(Option.fromUndefinedOr(this.env.BANCOLOMBIA_SANDBOX_GRANT_KEY), Redacted.make)
      )
    );
  }

  /** Durable alarm recovers abandoned work even when its User never submits another Turn. */
  alarm(): Promise<void> {
    const action = this.pending.then(() => this.recoverAbandonedWork());
    this.pending = action.then(
      () => undefined,
      () => undefined
    );
    return observeWorkerPromise(() => action, {
      environment: workerRelease(this.env),
      telemetry: cloudflareWorkerTelemetry,
      operation: "worker.core.alarm",
    });
  }

  private recoverAbandonedWork(): Promise<void> {
    return makeAgentService({
      connectionAdmission: bancolombiaSandboxAdmission(this.env),
      environment: this.env,
      userId: UserId.make(this.state.id.name),
      scheduleRecovery: (due) => this.state.storage.setAlarm(due),
    }).recover();
  }
}

/** Advance at most four incomplete Users once per private scheduled tick. */
export const repairDashboardProjections: typeof ownerRepairDashboardProjections = (...args) =>
  ownerRepairDashboardProjections(...args);

const erasureStores = (db: D1Database): ReadonlyArray<ErasureStore> => [
  ...makeAgentErasureStores(db),
  ...makeAuditErasureStores(db),
  ...makeBrowserLoginErasureStores(db),
  ...makeBudgetsErasureStores(db),
  ...makeCanonicalAdmissionErasureStores(db),
  ...makeCategoriesErasureStores(db),
  ...makeConnectionsErasureStores(db),
  ...makeConsentErasureStores(db),
  ...makeDashboardErasureStores(db),
  ...makeEmailAuthenticationErasureStores(db),
  ...makeIdentityErasureStores(db),
  ...makeIngestionErasureStores(db),
  ...makeInsightsErasureStores(db),
  ...makeMemoryErasureStores(db),
  ...makeOauthAgentsErasureStores(db),
  ...makeOauthConfirmationErasureStores(db),
  ...makeProviderAuthenticationErasureStores(db),
  ...makeQuotasErasureStores(db),
  ...makeRecoveryErasureStores(db),
  ...makeRecurringErasureStores(db),
  ...makeRecurringPlansErasureStores(db),
  ...makeResourceAdmissionErasureStores(db),
  ...makeSubscriptionErasureStores(db),
  ...makeTokensErasureStores(db),
  ...makeTransactionsErasureStores(db),
  ...makeWebSessionErasureStores(db),
  ...makeWhatsappErasureStores(db),
];

export const makeTransactionsErasureStores = (db: D1Database): ReadonlyArray<ErasureStore> =>
  erasureProjections.map((projection) => makeErasureStore({ db, projection }));
