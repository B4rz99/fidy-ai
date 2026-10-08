import { releaseOutstandingResource } from "../../resource-admission/operations";
import { maximumSubmissionInputBytes } from "../contract";
import {
  StagedStatementBytes,
  type StatementStagingFailureReason,
  StatementSubmission,
  StatementSubmissionId,
  SubmitForExtractionInput,
} from "../../../src/shell/ingestion/contract";
import {
  dailyAuditExhausted,
  prepareAuthorizedAuditCall,
  recordCanonicalPATWork,
  refusedByAuditBudget,
} from "../../../src/shell/audit/operations";
import type { OAuthCaller } from "../../../src/shell/oauth-agents/contract";
import { liveWebSessionAuthority } from "../../../src/shell/identity/operations";
import { livePATAuthority, recordLivePATUse } from "../../../src/shell/tokens/operations";
import { Clock, Data, Effect, Function, Option, Result, Schema } from "effect";
import {
  type StatementPublicationRefusal,
  StatementStaging,
  type StatementStagingConfig,
  type StoredStatementSubmission,
  newIngestionId,
  readOwnedStatementSubmission,
  stagedMaterialMessage,
  statementSubmissionReadAudit,
  submissionProjection,
} from "./statement-staging";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { RequestBodyPolicy } from "../../http/contract";
import { boundedJsonBody } from "../../http/operations";
import { ResourceAdmissionRefused } from "../../resource-admission/contract";
import {
  admitStatementUpload,
  statementUploadAuthority,
  uploadWindowMilliseconds,
} from "./statement-upload-admission";
import {
  type QueryCaller,
  type TransactionSubject,
  callerAuthority,
  isOAuthCaller,
  isPATCaller,
  refusedTransactionWork,
} from "../../canonical-work/operations";
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

const maximumAdmissionSweep = 128;
const noStore = { "cache-control": "no-store" } as const;

const submissionInputPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: maximumSubmissionInputBytes,
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

/** The statement owner's single message and answer for a spent shared daily canonical budget. */
export const statementDailyBudgetMessage =
  "Too many statement calls today; retry after the daily budget resets.";
export const statementDailyBudgetResponse = (): Response =>
  json(
    { error: { code: "rate_limited", message: statementDailyBudgetMessage }, next: [] },
    HTTP_TOO_MANY_REQUESTS
  );

/** The one message every absent or foreign submission shares; an id never proves ownership. */
const submissionNotFound = (): Response =>
  json(
    { error: { code: "not_found", message: "Statement submission unavailable." }, next: [] },
    HTTP_NOT_FOUND
  );

/** The one HTTP status for a closed canonical refusal code. */
const refusalStatus = (code: StatementPublicationRefusal["code"]): number => {
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
export const statementRefusalResponse = (refusal: StatementPublicationRefusal): Response =>
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
export const submissionResponse: {
  (status: number): (stored: StoredStatementSubmission) => Effect.Effect<Option.Option<Response>>;
  (stored: StoredStatementSubmission, status: number): Effect.Effect<Option.Option<Response>>;
} = Function.dual(2, (stored: StoredStatementSubmission, status: number) =>
  Option.match(submissionProjection(stored), {
    onNone: () => Effect.succeed(Option.none<Response>()),
    onSome: (value) =>
      Schema.encodeEffect(StatementSubmissionOutput)(value).pipe(
        Effect.map((data) => Option.some(json({ data, next: [] }, status))),
        Effect.orElseSucceed(() => Option.none<Response>())
      ),
  })
);

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
    const nowEpochMs = yield* Clock.currentTimeMillis;
    const staging = stagingService(environment, nowEpochMs);
    if (Option.isNone(staging)) return unavailable();
    const admission = statementUploadAuthority({ db: environment.DB, current: nowEpochMs });
    const admitted = yield* Effect.result(
      admitStatementUpload({
        db: environment.DB,
        userId: subject.userId,
        current: nowEpochMs,
        statements: () => [],
      })
    );
    if (Result.isFailure(admitted)) {
      return admitted.failure instanceof ResourceAdmissionRefused ? rateLimited() : unavailable();
    }
    // The claim is held only while this upload is in flight; its lease bounds an interrupted one.
    const staged = yield* Effect.result(
      staging.value.stageStatementBytes({ request, userId: subject.userId }).pipe(
        Effect.ensuring(
          releaseOutstandingResource(admission, {
            grantId: admitted.success.grantId,
            statements: [],
          }).pipe(Effect.ignore)
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

/** Sweep only expired upload admission grants, not proof/outbox grants belonging to other owners. */
export const sweepExpiredUploadAdmission = ({
  db,
  now,
}: Readonly<{ db: D1Database; now: number }>): Effect.Effect<void, IngestionAuditFailed> =>
  Effect.tryPromise({
    try: () =>
      db.batch([
        db
          .prepare(
            `DELETE FROM resource_admission_events WHERE grant_id IN (
            SELECT g.id FROM resource_admission_grants g
            WHERE g.id LIKE 'ingestion-upload-%'
              AND g.admitted_at_epoch_ms <= ?
              AND NOT EXISTS (
                SELECT 1 FROM resource_admission_events e
                WHERE e.grant_id = g.id AND e.expires_at_epoch_ms > ?
              )
            ORDER BY g.admitted_at_epoch_ms LIMIT ?
          )`
          )
          .bind(now - uploadWindowMilliseconds, now, maximumAdmissionSweep),
        db
          .prepare(
            `DELETE FROM resource_admission_grants
           WHERE id LIKE 'ingestion-upload-%' AND admitted_at_epoch_ms <= ?
             AND NOT EXISTS (SELECT 1 FROM resource_admission_events e WHERE e.grant_id = id)`
          )
          .bind(now - uploadWindowMilliseconds),
      ]),
    catch: (cause) => new IngestionAuditFailed({ cause }),
  }).pipe(Effect.asVoid);

/**
 * The one answer to a refusal the caller's own live credential decides: the credential refusal,
 * classified against live authority, or this endpoint's canonical unavailable answer. It is this
 * endpoint's seam rather than the transaction boundary's own `refusedCredentialResponse` because an
 * unreadable authority must answer with the ingestion failure contract, not the transaction one.
 */
const refusedCredential = ({
  db,
  subject,
}: Readonly<{ db: D1Database; subject: QueryCaller }>): Effect.Effect<Response> =>
  Effect.tryPromise({
    try: () => refusedTransactionWork({ db, subject }),
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(unavailable));

/** Decodes one bounded canonical submission input before it reaches the User coordination turn. */
export const submitForExtractionInput = (
  request: Request
): Effect.Effect<Option.Option<SubmitForExtractionInput>> =>
  boundedJsonBody({ request, policy: submissionInputPolicy, schema: SubmitForExtractionInput });

/**
 * One canonical read's attribution: a session caller commits one metadata-only read audit row, and
 * a PAT caller advances its activity and commits one accepted `pat_audit` row (never both, so a
 * read counts once toward the shared daily budget). A malformed id binds no value, so it is still
 * audited as absent.
 */
const oauthReadAudit = (
  input: Readonly<{
    database: D1Database;
    subject: OAuthCaller;
    current: number;
    operation: StatementAuditRead["operation"];
  }>
): D1PreparedStatement =>
  prepareAuthorizedAuditCall({
    db: input.database,
    authority: callerAuthority(input),
    id: newIngestionId(),
    current: input.current,
    operation: input.operation,
    outcome: "accepted",
    afterOwnerWrite: false,
  });

const readStatements = (
  input: Readonly<{
    current: number;
    database: D1Database;
    subject: QueryCaller;
    submissionId: string;
    operation: "ingestion.getStatementSubmission" | "ingestion.listNeedsReviewItems";
  }>
): ReadonlyArray<D1PreparedStatement> => {
  const { current, database, subject, submissionId, operation } = input;
  if (isOAuthCaller(subject)) {
    return [oauthReadAudit({ database, subject, current, operation })];
  }
  if (!isPATCaller(subject)) {
    const authority = liveWebSessionAuthority({ subject, current });
    return [
      operation === "ingestion.listNeedsReviewItems"
        ? prepareAuthorizedAuditCall({
            db: database,
            authority,
            id: newIngestionId(),
            operation,
            outcome: "success",
            current,
            afterOwnerWrite: false,
          })
        : statementSubmissionReadAudit({
            authority,
            current,
            database,
            id: newIngestionId(),
            submissionId,
          }),
    ];
  }
  return [
    recordLivePATUse({ subject, current }),

    recordCanonicalPATWork({
      input: {
        afterOwnerWrite: false,
        current,
        id: newIngestionId(),
        operation,
        outcome: "accepted",
      },
      authority: livePATAuthority({ subject, current }),
    }),
  ].map(({ sql, params }) => database.prepare(sql).bind(...params));
};

/** Commits one read's attribution unit: `None` when it stands, or the refusal a dead authority
 * proves. A dead credential writes nothing, so a refused read leaves no audit row. */
type StatementAuditRead = Readonly<{
  submissionId: string;
  operation: "ingestion.getStatementSubmission" | "ingestion.listNeedsReviewItems";
}>;

export const commitReadAudit: {
  (
    subject: QueryCaller,
    read: StatementAuditRead
  ): (environment: StatementIngestionEnvironment) => Effect.Effect<Option.Option<Response>>;
  (
    environment: StatementIngestionEnvironment,
    subject: QueryCaller,
    read: StatementAuditRead
  ): Effect.Effect<Option.Option<Response>>;
} = Function.dual(
  3,
  (environment: StatementIngestionEnvironment, subject: QueryCaller, read: StatementAuditRead) =>
    Effect.gen(function* () {
      const isPAT = isPATCaller(subject);
      const current = yield* Clock.currentTimeMillis;
      const outcome = yield* Effect.result(
        Effect.tryPromise({
          try: () =>
            environment.DB.batch([
              ...readStatements({
                current,
                database: environment.DB,
                subject,
                submissionId: read.submissionId,
                operation: read.operation,
              }),
            ]),
          catch: (cause) => new IngestionAuditFailed({ cause }),
        })
      );
      if (Result.isFailure(outcome)) {
        return Option.some(
          refusedByAuditBudget(outcome.failure.cause)
            ? statementDailyBudgetResponse()
            : unavailable()
        );
      }
      const results = outcome.success;
      const committed =
        results[0]?.meta.changes === 1 && (!isPAT || results[1]?.meta.changes === 1);
      if (committed) return Option.none<Response>();
      return Option.some(yield* refusedCredential({ db: environment.DB, subject }));
    })
);

/** One canonical submission query, with prepared transport authority and optional conversation scope. */
export const readCanonicalSubmission = ({
  config,
  userId,
  submissionId,
  scope,
}: Readonly<{
  config: Pick<StatementStagingConfig, "database">;
  userId: string;
  submissionId: StatementSubmissionId;
  scope: Option.Option<OwnedStatement>;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (Option.isSome(scope)) {
      const eligible = yield* Effect.tryPromise(() =>
        config.database
          .prepare(
            `SELECT 1 FROM statement_submissions WHERE id=? AND user_id=? AND (${scope.value.sql})`
          )
          .bind(submissionId, userId, ...scope.value.params)
          .first()
      );
      if (eligible === null) return submissionNotFound();
    }
    const stored = yield* readOwnedStatementSubmission(config, { userId, submissionId });
    if (Option.isNone(stored)) return submissionNotFound();
    const response = yield* submissionResponse(stored.value, HTTP_OK);
    return Option.getOrElse(response, submissionNotFound);
  }).pipe(Effect.catchCause(() => Effect.succeed(unavailable())));

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
  subject: QueryCaller;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    if (yield* budgetSpent(environment.DB, subject.userId, current)) {
      return statementDailyBudgetResponse();
    }
    const pathId = new URL(request.url).pathname.split("/").at(-1) ?? "";
    const submissionId = Schema.decodeOption(StatementSubmissionId)(pathId);
    const refused = yield* commitReadAudit(environment, subject, {
      submissionId: Option.getOrElse(submissionId, () => ""),
      operation: "ingestion.getStatementSubmission",
    });
    if (Option.isSome(refused)) return refused.value;
    if (Option.isNone(submissionId)) return submissionNotFound();
    return yield* readCanonicalSubmission({
      config: { database: environment.DB },
      userId: subject.userId,
      submissionId: submissionId.value,
      scope: Option.none(),
    });
  }).pipe(Effect.orElseSucceed(unavailable));
