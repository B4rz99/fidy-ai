import { executeRefundSupportAdmission } from "../subscription/operations";
import { WeeklyActivity, type WeeklyEnvironment } from "../insights/contract";
import { executeWeeklyWork } from "../insights/runtime";
import { RecurringWork } from "../recurring/contract";
import { evaluateRecurringSeries } from "../recurring/operations";
import { makeAgentService } from "../agent/runtime";
import { repairDashboardProjections as ownerRepairDashboardProjections } from "./internal/dashboard-repair";
import { CanonicalWorkAdmission } from "../canonical-operations/contract";
import {
  canonicalWorkRequiresInference,
  executeCanonicalWork,
  executeOAuthCanonicalWork,
} from "../canonical-operations/operations";
import { OAuthCanonicalAdmission } from "../../src/shell/mcp/contract";
import { OAuthRefreshAdmission, OAuthRevocationAdmission } from "../oauth-agents/contract";
import { executeOAuthRefresh, executeOAuthRevocation } from "../oauth-agents/operations";
import type { HostedCommitFence } from "../agent/contract";
import { UserId } from "../../src/core/identity/contract";

import { Clock, Data, DateTime, Effect, Exit, Option, Schema, type Scope } from "effect";

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
  observeWorkerResponse,
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
      STATEMENT_STAGING_BUCKET: R2Bucket;
      EMAIL_BUCKET: R2Bucket;
      KAPSO_API_KEY: string;
      WOMPI_ENVIRONMENT: string;
    }>
  > &
  WorkersAiEnvironment &
  WeeklyEnvironment;

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
const privateWeeklyActivity = (
  input: Readonly<{
    request: Request;
    candidate: unknown;
    environment: CoordinatorEnvironment;
    userId: string;
  }>
): Option.Option<Effect.Effect<Response>> => {
  if (input.request.method !== "POST" || new URL(input.request.url).pathname !== "/weekly-work") {
    return Option.none();
  }
  const work = Schema.decodeUnknownOption(WeeklyActivity)(input.candidate);
  if (Option.isNone(work) || work.value.userId !== input.userId) {
    return Option.some(Effect.succeed(transactionUnavailable()));
  }
  return Option.some(
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        executeWeeklyWork({
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

const privateOwnerActivity = (
  input: Parameters<typeof privateWeeklyActivity>[0]
): Option.Option<Effect.Effect<Response>> => {
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
  return privateWeeklyActivity(input).pipe(
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
  // Reserved smoke compatibility never enters User coordination or reads D1.
  if (userId !== "_release-smoke-v1") return Option.none();
  return Option.some(
    Promise.resolve(
      path === "/release-smoke" && method === "GET"
        ? Response.json({ status: "compatible" })
        : Response.json({}, { status: 404 })
    )
  );
};

/** One instance per stable User coordinates mutations; D1 alone owns the FinancialRecord. */
export class UserTransactionCoordinator {
  private pending: Promise<void> = Promise.resolve();
  private readonly state: Readonly<{
    id: Readonly<{ name: string }>;
    storage: Pick<DurableObjectStorage, "setAlarm">;
  }>;
  private readonly env: CoordinatorEnvironment;
  constructor(
    state: Readonly<{
      id: Readonly<{ name: string }>;
      storage: Pick<DurableObjectStorage, "setAlarm">;
    }>,
    env: CoordinatorEnvironment
  ) {
    this.state = state;
    this.env = env;
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
    const hosted = makeAgentService({
      environment,
      userId: UserId.make(userId),
      scheduleRecovery: (due) => this.state.storage.setAlarm(due),
    }).accept({ request, preceding: this.pending });
    if (Option.isSome(hosted)) {
      this.pending = hosted.value.settled;
      return observeWorkerResponse(() => hosted.value.response, {
        environment: workerRelease(environment),
        telemetry: cloudflareWorkerTelemetry,
        operation: "worker.core.coordinator",
      });
    }
    const prior = this.pending;
    const response = observeWorkerResponse(
      () => prior.then(() => this.runCoordinatedRequest({ request, userId })),
      {
        environment: workerRelease(environment),
        telemetry: cloudflareWorkerTelemetry,
        operation: "worker.core.coordinator",
      }
    );
    this.pending = response.then(
      () => undefined,
      () => undefined
    );
    return response;
  }

  private runCoordinatedRequest(
    input: Readonly<{
      request: Request;
      userId: string;
    }>
  ): Promise<Response> {
    const { request, userId } = input;
    const environment = this.env;
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const candidate = yield* Effect.option(Effect.tryPromise(() => request.json()));
          if (Option.isNone(candidate)) return transactionUnavailable();
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
          if (Option.isSome(oauth)) return yield* oauth.value;
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
      environment: this.env,
      userId: UserId.make(this.state.id.name),
      scheduleRecovery: (due) => this.state.storage.setAlarm(due),
    }).recover();
  }
}

/** Advance at most four incomplete Users once per private scheduled tick. */
export const repairDashboardProjections: typeof ownerRepairDashboardProjections = (...args) =>
  ownerRepairDashboardProjections(...args);
