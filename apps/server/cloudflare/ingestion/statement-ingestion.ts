import {
  StagedStatementBytes,
  type StatementStagingFailureReason,
  StatementSubmission,
  StatementSubmissionId,
  SubmitForExtractionInput,
} from "@fidy/server/statement-staging";
import {
  recordAuditedPATUse,
  recordCanonicalPATWork,
  recordLivePATUse,
} from "@fidy/server/tokens-runtime";
import { Data, DateTime, Effect, Option, Result, Schema } from "effect";
import type * as Arr from "effect/Array";
import { RequestBodyPolicy, boundedJsonBody } from "../http/request-body";
import type { AuthorizedPAT } from "../pats/pat-authorization";
import { currentMillis } from "../pats/pat-shared";
import { prepareOwnedStatement } from "../pats/pat-unit";
import {
  ResourceAdmissionAuthority,
  ResourceAdmissionCharges,
  type ResourceAdmissionCharges as ResourceAdmissionChargesType,
  ResourceAdmissionDurationMs,
  ResourceAdmissionEpochMs,
  ResourceAdmissionGrantId,
  ResourceAdmissionLimit,
  ResourceAdmissionPolicies,
  ResourceAdmissionPolicyKey,
  ResourceAdmissionRefused,
  ResourceAdmissionScopeKey,
  ResourceAdmissionUnits,
} from "../resource-admission/authority";
import {
  type TransactionCaller,
  type TransactionSubject,
  callerAuthority,
  isPATCaller,
  refusedTransactionWork,
  transactionAuditExhausted,
} from "../transactions/transaction-boundary";
import {
  type ReplayStatements,
  StatementStaging,
  type StatementStagingFailed,
  type StatementStagingRefused,
  type StatementStagingUnavailable,
  type StoredStatementSubmission,
  newIngestionId,
  statementAuditLimitMarker,
  statementSubmissionReadAudit,
  statementSubmissionRefusalAudit,
  statementSubmissionReplayAudit,
} from "./statement-staging";

/** One audit batch that could not settle; its cause's stable marker classifies the refusal. */
class IngestionAuditFailed extends Data.TaggedError("IngestionAuditFailed")<{
  readonly cause: unknown;
}> {}

/** True while the caller's shared stable-User canonical work budget is already spent. */
const budgetSpent = (
  database: D1Database,
  userId: string,
  current: number
): Effect.Effect<boolean, IngestionAuditFailed> =>
  Effect.tryPromise({
    try: () => transactionAuditExhausted({ db: database, userId, current }),
    catch: (cause) => new IngestionAuditFailed({ cause }),
  });

/** Private Core Worker bindings statement acceptance needs. */
export type StatementIngestionEnvironment = Readonly<{ readonly DB: D1Database }> &
  Partial<Readonly<{ STATEMENT_STAGING_BUCKET: R2Bucket }>>;

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_ACCEPTED = 202;
const HTTP_BAD_REQUEST = 400;
const HTTP_PAYWALL = 402;
const HTTP_NOT_FOUND = 404;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_UNAVAILABLE = 503;
const submissionInputBytes = 4096;
const uploadWindowMilliseconds = 3_600_000;
const uploadLeaseMilliseconds = 600_000;
const maximumUploadsPerUserPerHour = 20;
const maximumUploadsPerHour = 500;
const maximumConcurrentUploads = 2;
const oneUnit = ResourceAdmissionUnits.make(1);
const noStore = { "cache-control": "no-store" } as const;

/**
 * Worker-owned upload admission. Byte, content, and reference bounds live in the staging service;
 * these claims bound how often one User may start an upload and how much private R2-backed
 * transient material all Users may create per hour before any staging row or object exists.
 */
const ingestionPolicies = ResourceAdmissionPolicies.make([
  {
    dimension: "stable_user",
    durationMs: ResourceAdmissionDurationMs.make(uploadWindowMilliseconds),
    key: ResourceAdmissionPolicyKey.make("ingestion.upload.user.v1"),
    kind: "rolling_window",
    limit: ResourceAdmissionLimit.make(maximumUploadsPerUserPerHour),
  },
  {
    dimension: "operation",
    durationMs: ResourceAdmissionDurationMs.make(uploadWindowMilliseconds),
    key: ResourceAdmissionPolicyKey.make("ingestion.upload.operation.v1"),
    kind: "rolling_window",
    limit: ResourceAdmissionLimit.make(maximumUploadsPerHour),
  },
  {
    dimension: "spend",
    durationMs: ResourceAdmissionDurationMs.make(uploadWindowMilliseconds),
    key: ResourceAdmissionPolicyKey.make("ingestion.upload.spend.v1"),
    kind: "rolling_window",
    limit: ResourceAdmissionLimit.make(maximumUploadsPerHour),
  },
  {
    dimension: "outstanding_work",
    key: ResourceAdmissionPolicyKey.make("ingestion.upload.outstanding.v1"),
    kind: "outstanding",
    leaseMs: ResourceAdmissionDurationMs.make(uploadLeaseMilliseconds),
    limit: ResourceAdmissionLimit.make(maximumConcurrentUploads),
  },
]);

const ingestionCharges = (userId: string): ResourceAdmissionChargesType =>
  ResourceAdmissionCharges.make([
    {
      policyKey: ResourceAdmissionPolicyKey.make("ingestion.upload.user.v1"),
      scopeKey: ResourceAdmissionScopeKey.make(userId),
      units: oneUnit,
    },
    {
      policyKey: ResourceAdmissionPolicyKey.make("ingestion.upload.operation.v1"),
      scopeKey: ResourceAdmissionScopeKey.make("statement-staging"),
      units: oneUnit,
    },
    {
      policyKey: ResourceAdmissionPolicyKey.make("ingestion.upload.spend.v1"),
      scopeKey: ResourceAdmissionScopeKey.make("r2-statement-staging"),
      units: oneUnit,
    },
    {
      policyKey: ResourceAdmissionPolicyKey.make("ingestion.upload.outstanding.v1"),
      scopeKey: ResourceAdmissionScopeKey.make(userId),
      units: oneUnit,
    },
  ]);

const submissionInputPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: submissionInputBytes,
  deadlineMilliseconds: 2_000,
});

const StatementSubmissionOutput = Schema.toCodecJson(StatementSubmission);
const StagedStatementOutput = Schema.toCodecJson(StagedStatementBytes);

const json = (body: unknown, status: number): Response =>
  Response.json(body, { headers: noStore, status });

const unavailable = (): Response =>
  json(
    {
      error: { code: "unavailable", message: "Canonical operation is temporarily unavailable." },
      next: [],
    },
    HTTP_UNAVAILABLE
  );

const validationFailed = (message: string): Response =>
  json({ error: { code: "validation_failed", fields: [], message }, next: [] }, HTTP_BAD_REQUEST);

const payloadTooLarge = (message: string): Response =>
  json(
    { error: { code: "validation_failed", fields: [], message }, next: [] },
    HTTP_PAYLOAD_TOO_LARGE
  );

const rateLimited = (): Response =>
  json(
    {
      error: {
        code: "rate_limited",
        message: "Too many statement uploads; wait before staging another file.",
      },
      next: [],
    },
    HTTP_TOO_MANY_REQUESTS
  );

/** The one bounded answer when a User's shared daily canonical budget is spent. */
const dailyBudgetSpent = (): Response =>
  json(
    {
      error: {
        code: "rate_limited",
        message: "Too many statement calls today; retry after the daily budget resets.",
      },
      next: [],
    },
    HTTP_TOO_MANY_REQUESTS
  );

const paywallRequired = (): Response =>
  json(
    {
      error: {
        code: "paywall_required",
        message:
          "This User has already used the lifetime Free statement backfill. Upgrade to Pro before submitting another statement.",
      },
      next: [],
    },
    HTTP_PAYWALL
  );

/** The one message every absent or foreign submission shares; an id never proves ownership. */
const submissionNotFound = (): Response =>
  json(
    { error: { code: "not_found", message: "Statement submission unavailable." }, next: [] },
    HTTP_NOT_FOUND
  );

const stagingService = (
  environment: StatementIngestionEnvironment
): Option.Option<ReturnType<typeof StatementStaging.make>> =>
  Option.map(Option.fromUndefinedOr(environment.STATEMENT_STAGING_BUCKET), (bucket) =>
    StatementStaging.make({ bucket, database: environment.DB, nowEpochMs: currentMillis })
  );

/** The fields every StatementSubmission status carries, decoded once from storage. */
type SubmissionBase = Readonly<{
  id: ReturnType<typeof StatementSubmissionId.make>;
  parserRevision: string;
  sourceFormat: "csv" | "xlsx";
  submittedAt: DateTime.Utc;
}>;

const submissionBase = (stored: StoredStatementSubmission): SubmissionBase => ({
  id: StatementSubmissionId.make(stored.id),
  parserRevision: stored.parserRevision,
  sourceFormat: stored.sourceFormat,
  submittedAt: DateTime.makeUnsafe(stored.submittedAtMs),
});

/** A failed submission can only project when it kept its timestamps and its closed failure reason. */
const failedProjection = (
  base: SubmissionBase,
  stored: StoredStatementSubmission
): Option.Option<StatementSubmission> => {
  if (
    Option.isNone(stored.startedAtMs) ||
    Option.isNone(stored.completedAtMs) ||
    Option.isNone(stored.failureReason)
  ) {
    return Option.none();
  }
  return Option.some({
    ...base,
    completedAt: DateTime.makeUnsafe(stored.completedAtMs.value),
    failureReason: stored.failureReason.value,
    startedAt: DateTime.makeUnsafe(stored.startedAtMs.value),
    status: "failed",
  });
};

/** A completed submission can only project when its row accounting conserves input rows. */
const completedProjection = (
  base: SubmissionBase,
  stored: StoredStatementSubmission
): Option.Option<StatementSubmission> => {
  if (
    Option.isNone(stored.startedAtMs) ||
    Option.isNone(stored.completedAtMs) ||
    Option.isNone(stored.inputRows) ||
    Option.isNone(stored.acceptedRows) ||
    Option.isNone(stored.needsReviewRows)
  ) {
    return Option.none();
  }
  return Option.some({
    ...base,
    accounting: {
      acceptedRows: stored.acceptedRows.value,
      inputRows: stored.inputRows.value,
      needsReviewRows: stored.needsReviewRows.value,
    },
    completedAt: DateTime.makeUnsafe(stored.completedAtMs.value),
    startedAt: DateTime.makeUnsafe(stored.startedAtMs.value),
    status: "completed",
  });
};

/** One stored submission rebuilt into the canonical projection; an impossible row is absent. */
const submissionProjection = (
  stored: StoredStatementSubmission
): Option.Option<StatementSubmission> => {
  const base = submissionBase(stored);
  if (stored.status === "queued") return Option.some({ ...base, status: "queued" });
  if (stored.status === "failed") return failedProjection(base, stored);
  if (stored.status === "completed") return completedProjection(base, stored);
  return Option.map(stored.startedAtMs, (startedAtMs) => ({
    ...base,
    startedAt: DateTime.makeUnsafe(startedAtMs),
    status: "processing",
  }));
};

/** Encodes one stored submission into the canonical response body, or `None` for a broken row. */
const submissionResponse = (
  stored: StoredStatementSubmission,
  status: number
): Effect.Effect<Option.Option<Response>> =>
  Option.match(submissionProjection(stored), {
    onNone: () => Effect.succeed(Option.none<Response>()),
    onSome: (value) =>
      Schema.encodeEffect(StatementSubmissionOutput)(value).pipe(
        Effect.map((data) => Option.some(json({ data, next: [] }, status))),
        Effect.orElseSucceed(() => Option.none<Response>())
      ),
  });

/** Every closed publication refusal, as its bounded canonical failure and audit outcome. */
type PublicationRefusal = Readonly<{
  audit: "resource_limit" | "validation_failed";
  respond: () => Response;
}>;

const publicationRefusals: Record<StatementStagingFailureReason, PublicationRefusal> = {
  cancelled: { audit: "validation_failed", respond: unavailable },
  conflict: {
    audit: "validation_failed",
    respond: () =>
      validationFailed(
        "The idempotency key already names different statement material. Stage that material and use a new key."
      ),
  },
  "malformed-file": {
    audit: "validation_failed",
    respond: () =>
      validationFailed("The staged statement material is unavailable; upload the file again."),
  },
  "not-found": {
    audit: "validation_failed",
    respond: () =>
      validationFailed("The staged statement material is unavailable; upload the file again."),
  },
  paywall: { audit: "resource_limit", respond: paywallRequired },
  "resource-limit": {
    audit: "resource_limit",
    respond: () =>
      validationFailed("Finish existing statement extraction work before uploading another file."),
  },
  "retention-expired": {
    audit: "validation_failed",
    respond: () =>
      validationFailed("The staged statement material is unavailable; upload the file again."),
  },
  "unsupported-format": {
    audit: "validation_failed",
    respond: () =>
      validationFailed("The staged statement material is unavailable; upload the file again."),
  },
};

/** Every closed staging refusal, as its one bounded transport response. None echoes bytes. */
const stagingFailureResponses: Record<StatementStagingFailureReason, () => Response> = {
  cancelled: () =>
    validationFailed("The statement upload did not complete; upload the file again."),
  conflict: () =>
    validationFailed("The staged statement material is unavailable; upload the file again."),
  "malformed-file": () => validationFailed("The uploaded statement is malformed."),
  "not-found": () =>
    validationFailed("The staged statement material is unavailable; upload the file again."),
  paywall: unavailable,
  "resource-limit": () => payloadTooLarge("A statement file may be at most 5 MiB."),
  "retention-expired": () =>
    validationFailed("The staged statement material is unavailable; upload the file again."),
  "unsupported-format": () =>
    validationFailed("The uploaded bytes are not a CSV or XLSX statement."),
};

/**
 * Stages one User's bounded statement bytes in private R2 after admission. Raw bytes and the
 * claimed content type never influence what may become durable staging state; the response is the
 * non-authoritative reference a canonical submission cites, never a readable statement.
 */
export const uploadStagedStatement = ({
  request,
  environment,
  subject,
}: Readonly<{
  request: Request;
  environment: StatementIngestionEnvironment;
  subject: TransactionSubject;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const staging = stagingService(environment);
    if (Option.isNone(staging)) return unavailable();
    const nowEpochMs = currentMillis();
    const admission = ResourceAdmissionAuthority.make({
      database: environment.DB,
      nowEpochMs: () => ResourceAdmissionEpochMs.make(nowEpochMs),
      policies: ingestionPolicies,
    });
    const grantId = ResourceAdmissionGrantId.make(newIngestionId());
    const admitted = yield* Effect.result(
      admission.admit({ charges: ingestionCharges(subject.userId), grantId, statements: [] })
    );
    if (Result.isFailure(admitted)) {
      return admitted.failure instanceof ResourceAdmissionRefused ? rateLimited() : unavailable();
    }
    // The claim is held only while this upload is in flight; its lease bounds an interrupted one.
    const staged = yield* Effect.result(
      staging.value
        .stageStatementBytes({ request, userId: subject.userId })
        .pipe(
          Effect.ensuring(
            admission.releaseOutstandingWork({ grantId, statements: [] }).pipe(Effect.ignore)
          )
        )
    );
    if (Result.isFailure(staged)) {
      return staged.failure._tag === "StatementStagingFailed"
        ? stagingFailureResponses[staged.failure.reason]()
        : unavailable();
    }
    const encoded = yield* Schema.encodeEffect(StagedStatementOutput)(staged.success).pipe(
      Effect.orElseSucceed(() => undefined)
    );
    return encoded === undefined ? unavailable() : json({ data: encoded, next: [] }, HTTP_CREATED);
  });

/** The PAT canonical audit and the activity update it gates, committed by the same unit. */
const patAccountability = ({
  database,
  subject,
  current,
  auditId,
}: Readonly<{
  database: D1Database;
  subject: AuthorizedPAT;
  current: number;
  auditId: string;
}>): Arr.NonEmptyArray<D1PreparedStatement> => [
  prepareOwnedStatement({
    db: database,
    statement: recordCanonicalPATWork({
      input: {
        afterSourceAttestation: true,
        current,
        id: auditId,
        operation: "ingestion.submitForExtraction",
        outcome: "accepted",
      },
      subject,
    }),
  }),
  prepareOwnedStatement({
    db: database,
    statement: recordAuditedPATUse({
      input: { auditId, current, operation: "ingestion.submitForExtraction" },
      subject,
    }),
  }),
];

/** Credential-specific accountability that must commit inside the publication unit. A session
 * publication writes its own audit row in the unit, so its caller-owned list is empty. */
const publicationAccountability = ({
  database,
  subject,
  current,
  auditId,
}: Readonly<{
  database: D1Database;
  subject: TransactionCaller;
  current: number;
  auditId: string;
}>): ReadonlyArray<D1PreparedStatement> =>
  isPATCaller(subject) ? patAccountability({ auditId, current, database, subject }) : [];

/**
 * Credential-specific accountability that must commit when a call replays an existing submission.
 * Every statement is live-authority guarded, so a credential revoked after dispatch refuses the
 * replay instead of returning stored state; a session caller's one row is its own replay audit.
 */
const replayAccountability = ({
  database,
  subject,
  current,
  auditId,
}: Readonly<{
  database: D1Database;
  subject: TransactionCaller;
  current: number;
  auditId: string;
}>): ReplayStatements =>
  isPATCaller(subject)
    ? patAccountability({ auditId, current, database, subject })
    : [
        statementSubmissionReplayAudit({
          authority: callerAuthority({ subject, current }),
          current,
          database,
          id: auditId,
        }),
      ];

/**
 * Publishes one authorized statement submission from a caller-held staged reference. Live caller
 * authority, the Free allowance, submission pressure, material ownership, size, and digest are
 * re-verified inside one D1 atomic unit before any authoritative row exists.
 */
export const submitStagedStatement = ({
  request,
  environment,
  subject,
}: Readonly<{
  request: Request;
  environment: StatementIngestionEnvironment;
  subject: TransactionCaller;
}>): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const staging = stagingService(environment);
      if (Option.isNone(staging)) return unavailable();
      const input = yield* Effect.tryPromise(() =>
        boundedJsonBody(request, submissionInputPolicy, SubmitForExtractionInput)
      );
      if (Option.isNone(input)) return validationFailed("Invalid statement submission input.");
      const current = currentMillis();
      if (yield* budgetSpent(environment.DB, subject.userId, current)) return dailyBudgetSpent();
      const accountabilityId = newIngestionId();
      const published = yield* Effect.result(
        staging.value.publishStagedStatementSubmission({
          authority: callerAuthority({ subject, current }),
          idempotencyKey: input.value.idempotencyKey,
          reference: input.value.reference,
          replayStatements: replayAccountability({
            auditId: accountabilityId,
            current,
            database: environment.DB,
            subject,
          }),
          statements: publicationAccountability({
            auditId: accountabilityId,
            current,
            database: environment.DB,
            subject,
          }),
          userId: subject.userId,
        })
      );
      if (Result.isFailure(published)) {
        return yield* refusedPublication({
          current,
          environment,
          failure: published.failure,
          subject,
        });
      }
      const stored = yield* staging.value.readOwnedStatementSubmission({
        submissionId: published.success.submissionId,
        userId: subject.userId,
      });
      if (Option.isNone(stored)) return unavailable();
      const response = yield* submissionResponse(stored.value, HTTP_ACCEPTED);
      return Option.getOrElse(response, () => unavailable());
    }).pipe(Effect.catchCause(() => Effect.succeed(unavailable())))
  );

/**
 * Answers one refused publication as the cause its own failure proves: a spent shared daily budget,
 * a dead credential, a closed domain refusal (which records its metadata-only audit), or an outage.
 */
const refusedPublication = (
  input: Readonly<{
    current: number;
    environment: StatementIngestionEnvironment;
    failure: StatementStagingFailed | StatementStagingRefused | StatementStagingUnavailable;
    subject: TransactionCaller;
  }>
): Effect.Effect<Response> => {
  if (input.failure._tag === "StatementStagingRefused") {
    return input.failure.reason === "budget"
      ? Effect.succeed(dailyBudgetSpent())
      : refusedRead(input.environment.DB, input.subject);
  }
  if (input.failure._tag === "StatementStagingFailed") {
    return recordRefusedSubmission({
      current: input.current,
      environment: input.environment,
      refusal: publicationRefusals[input.failure.reason],
      subject: input.subject,
    });
  }
  return Effect.succeed(unavailable());
};

/** The one bounded refusal when a caller's authority died before its unit committed: the shared
 * Transaction credential decision answers 401/403, and only a defect in that shared read falls back
 * to the canonical unavailable envelope every ingestion path uses. */
const refusedRead = (database: D1Database, subject: TransactionCaller): Effect.Effect<Response> =>
  Effect.tryPromise({
    try: () => refusedTransactionWork({ db: database, subject }),
    catch: (cause) => new IngestionAuditFailed({ cause }),
  }).pipe(Effect.orElseSucceed(unavailable));

/**
 * Records one refused submission attempt's metadata-only audit before its refusal is answered: a
 * PAT's rejected `pat_audit` row, or a session caller's bounded refusal outcome. A refusal whose
 * audit cannot commit for a dead credential, an exhausted daily budget, or an unavailable authority
 * is answered as that cause instead.
 */
const recordRefusedSubmission = (
  input: Readonly<{
    current: number;
    environment: StatementIngestionEnvironment;
    refusal: PublicationRefusal;
    subject: TransactionCaller;
  }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const statements = isPATCaller(input.subject)
      ? [
          prepareOwnedStatement({
            db: input.environment.DB,
            statement: recordCanonicalPATWork({
              input: {
                afterSourceAttestation: false,
                current: input.current,
                id: newIngestionId(),
                operation: "ingestion.submitForExtraction",
                outcome: "rejected",
              },
              subject: input.subject,
            }),
          }),
        ]
      : [
          statementSubmissionRefusalAudit({
            authority: callerAuthority({ subject: input.subject, current: input.current }),
            current: input.current,
            database: input.environment.DB,
            id: newIngestionId(),
            outcome: input.refusal.audit,
          }),
        ];
    const outcome = yield* Effect.result(
      Effect.tryPromise({
        try: () => input.environment.DB.batch([...statements]),
        catch: (cause) => new IngestionAuditFailed({ cause }),
      })
    );
    if (Result.isFailure(outcome)) {
      return String(outcome.failure.cause).includes(statementAuditLimitMarker)
        ? dailyBudgetSpent()
        : unavailable();
    }
    if (outcome.success[0]?.meta.changes !== 1) {
      return yield* refusedRead(input.environment.DB, input.subject);
    }
    return input.refusal.respond();
  });

/**
 * One canonical read's attribution: a session caller commits one metadata-only read audit row, and
 * a PAT caller advances its activity and commits one accepted `pat_audit` row (never both, so a
 * read counts once toward the shared daily budget). A malformed id binds no value, so it is still
 * audited as absent.
 */
const readStatements = (
  input: Readonly<{
    current: number;
    database: D1Database;
    subject: TransactionCaller;
    submissionId: string;
  }>
): ReadonlyArray<D1PreparedStatement> => {
  const { current, database, subject, submissionId } = input;
  if (!isPATCaller(subject)) {
    return [
      statementSubmissionReadAudit({
        authority: callerAuthority({ subject, current }),
        current,
        database,
        id: newIngestionId(),
        submissionId,
      }),
    ];
  }
  return [
    prepareOwnedStatement({ db: database, statement: recordLivePATUse({ subject, current }) }),
    prepareOwnedStatement({
      db: database,
      statement: recordCanonicalPATWork({
        input: {
          afterSourceAttestation: false,
          current,
          id: newIngestionId(),
          operation: "ingestion.getStatementSubmission",
          outcome: "accepted",
        },
        subject,
      }),
    }),
  ];
};

/** Commits one read's attribution unit: `None` when it stands, or the refusal a dead authority
 * proves. A dead credential writes nothing, so a refused read leaves no audit row. */
const commitReadAudit = (
  environment: StatementIngestionEnvironment,
  subject: TransactionCaller,
  submissionId: string
): Effect.Effect<Option.Option<Response>> =>
  Effect.gen(function* () {
    const isPAT = isPATCaller(subject);
    const outcome = yield* Effect.result(
      Effect.tryPromise({
        try: () =>
          environment.DB.batch([
            ...readStatements({
              current: currentMillis(),
              database: environment.DB,
              subject,
              submissionId,
            }),
          ]),
        catch: (cause) => new IngestionAuditFailed({ cause }),
      })
    );
    if (Result.isFailure(outcome)) {
      return Option.some(
        String(outcome.failure.cause).includes(statementAuditLimitMarker)
          ? dailyBudgetSpent()
          : unavailable()
      );
    }
    const results = outcome.success;
    const committed = results[0]?.meta.changes === 1 && (!isPAT || results[1]?.meta.changes === 1);
    return committed
      ? Option.none<Response>()
      : Option.some(yield* refusedRead(environment.DB, subject));
  });

/**
 * Reads one owned statement submission only after its canonical call committed a metadata-only
 * audit row under the caller's live authority; a dead credential writes nothing and is refused, and
 * every absent or foreign id shares the one bounded not-found answer.
 */
export const readStatementSubmission = ({
  request,
  environment,
  subject,
}: Readonly<{
  request: Request;
  environment: StatementIngestionEnvironment;
  subject: TransactionCaller;
}>): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const staging = stagingService(environment);
      if (Option.isNone(staging)) return unavailable();
      if (yield* budgetSpent(environment.DB, subject.userId, currentMillis())) {
        return dailyBudgetSpent();
      }
      const pathId = new URL(request.url).pathname.split("/").at(-1) ?? "";
      const submissionId = Schema.decodeOption(StatementSubmissionId)(pathId);
      const refused = yield* commitReadAudit(
        environment,
        subject,
        Option.getOrElse(submissionId, () => "")
      );
      if (Option.isSome(refused)) return refused.value;
      if (Option.isNone(submissionId)) return submissionNotFound();
      // This owned projection adds no authority: the audit above already committed under the caller.
      const stored = yield* staging.value.readOwnedStatementSubmission({
        submissionId: submissionId.value,
        userId: subject.userId,
      });
      if (Option.isNone(stored)) return submissionNotFound();
      const response = yield* submissionResponse(stored.value, HTTP_OK);
      return Option.getOrElse(response, () => submissionNotFound());
    }).pipe(Effect.catchCause(() => Effect.succeed(unavailable())))
  );
