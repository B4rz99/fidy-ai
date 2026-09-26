import {
  StagedStatementBytes,
  type StatementStagingFailureReason,
  StatementSubmission,
  StatementSubmissionId,
  SubmitForExtractionInput,
} from "@fidy/server/statement-staging";
import { recordCanonicalPATWork, recordLivePATUse } from "@fidy/server/tokens-runtime";
import { Data, Effect, Option, Result, Schema } from "effect";
import { dailyAuditExhausted, sharedAuditLimitRefusal } from "../atomic/daily-canonical-budget";
import type { AtomicMutationRefusal } from "../atomic/atomic-mutation-unit";
import { RequestBodyPolicy, boundedJsonBody } from "../http/request-body";
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
} from "../transactions/transaction-boundary";
import {
  StatementStaging,
  type StoredStatementSubmission,
  newIngestionId,
  stagedMaterialMessage,
  statementSubmissionReadAudit,
  submissionProjection,
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
    try: () => dailyAuditExhausted({ db: database, userId, current }),
    catch: (cause) => new IngestionAuditFailed({ cause }),
  });

/** Private Core Worker bindings statement acceptance needs. */
export type StatementIngestionEnvironment = Readonly<{ readonly DB: D1Database }> &
  Partial<Readonly<{ STATEMENT_STAGING_BUCKET: R2Bucket }>>;

const unavailable = (): Response => unavailableStatement();

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_BAD_REQUEST = 400;
const HTTP_PAYWALL = 402;
const HTTP_NOT_FOUND = 404;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_UNAVAILABLE = 503;
/** The body bound one canonical statement submission request accepts. */
export const submissionInputBytes = 4096;
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

const json = (body: unknown, status: number): Response =>
  Response.json(body, { headers: noStore, status });

export const unavailableStatement = (): Response =>
  json(
    {
      error: { code: "unavailable", message: "Canonical operation is temporarily unavailable." },
      next: [],
    },
    HTTP_UNAVAILABLE
  );

/** One bounded validation refusal whose issue list is always empty and carries no input detail. */
export const validationFailed = (message: string): Response =>
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

/** The one message every absent or foreign submission shares; an id never proves ownership. */
const submissionNotFound = (): Response =>
  json(
    { error: { code: "not_found", message: "Statement submission unavailable." }, next: [] },
    HTTP_NOT_FOUND
  );

/** The one HTTP status for a closed canonical refusal code. */
const refusalStatus = (code: AtomicMutationRefusal["code"]): number => {
  if (code === "paywall_required") return HTTP_PAYWALL;
  if (code === "rate_limited") return HTTP_TOO_MANY_REQUESTS;
  if (code === "unavailable") return HTTP_UNAVAILABLE;
  if (code === "not_found") return HTTP_NOT_FOUND;
  return HTTP_BAD_REQUEST;
};

/**
 * The one bounded HTTP answer for a closed canonical publication refusal. The refusal's own code,
 * message, and status are what every individual caller receives; a refusal never echoes bytes.
 */
export const statementRefusalResponse = (refusal: AtomicMutationRefusal): Response =>
  json(
    {
      error: {
        code: refusal.code,
        ...(refusal.code === "validation_failed" ? { fields: [] } : {}),
        message: refusal.message,
      },
      next: [],
    },
    refusalStatus(refusal.code)
  );

const stagingService = (
  environment: StatementIngestionEnvironment,
  current: number
): Option.Option<ReturnType<typeof StatementStaging.make>> =>
  Option.map(Option.fromUndefinedOr(environment.STATEMENT_STAGING_BUCKET), (bucket) =>
    StatementStaging.make({
      bucket,
      database: environment.DB,
      // One decision instant for the whole call, so staging bounds and the D1 unit cannot disagree.
      nowEpochMs: () => current,
    })
  );

/** Encodes one stored submission into the canonical response body, or `None` for a broken row. */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const submissionResponse = (
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

/** Every closed staging transport refusal, as its one bounded response. None echoes bytes. */
const stagingFailureResponses: Record<StatementStagingFailureReason, () => Response> = {
  cancelled: () =>
    validationFailed("The statement upload did not complete; upload the file again."),
  conflict: () => validationFailed(stagedMaterialMessage),
  "malformed-file": () => validationFailed("The uploaded statement is malformed."),
  "not-found": () => validationFailed(stagedMaterialMessage),
  paywall: unavailable,
  "resource-limit": () => payloadTooLarge("A statement file may be at most 5 MiB."),
  "retention-expired": () => validationFailed(stagedMaterialMessage),
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
    const nowEpochMs = currentMillis();
    const staging = stagingService(environment, nowEpochMs);
    if (Option.isNone(staging)) return unavailable();
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
    const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(StagedStatementBytes))(
      staged.success
    ).pipe(Effect.orElseSucceed(() => undefined));
    return encoded === undefined ? unavailable() : json({ data: encoded, next: [] }, HTTP_CREATED);
  });

/**
 * The one answer to a refusal the caller's own live credential decides: the credential refusal,
 * classified against live authority, or this endpoint's canonical unavailable answer. It is this
 * endpoint's seam rather than the transaction boundary's own `refusedCredentialResponse` because an
 * unreadable authority must answer with the ingestion failure contract, not the transaction one.
 */
const refusedCredential = ({
  db,
  subject,
}: Readonly<{ db: D1Database; subject: TransactionCaller }>): Effect.Effect<Response> =>
  Effect.tryPromise({
    try: () => refusedTransactionWork({ db, subject }),
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(unavailable));

/** Decodes one bounded canonical submission input before it reaches the User coordination turn. */
export const submitForExtractionInput = (
  request: Request
): Promise<Option.Option<SubmitForExtractionInput>> =>
  boundedJsonBody(request, submissionInputPolicy, SubmitForExtractionInput);

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
          afterOwnerWrite: false,
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
        sharedAuditLimitRefusal(outcome.failure.cause) ? dailyBudgetSpent() : unavailable()
      );
    }
    const results = outcome.success;
    const committed = results[0]?.meta.changes === 1 && (!isPAT || results[1]?.meta.changes === 1);
    if (committed) return Option.none<Response>();
    return Option.some(yield* refusedCredential({ db: environment.DB, subject }));
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
      const current = currentMillis();
      const staging = stagingService(environment, current);
      if (Option.isNone(staging)) return unavailable();
      if (yield* budgetSpent(environment.DB, subject.userId, current)) {
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
