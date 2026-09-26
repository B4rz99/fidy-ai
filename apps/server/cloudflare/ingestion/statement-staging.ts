import {
  type StagedStatementBytes,
  type StagedStatementReference,
  StatementContentDigest,
  StatementFailureReason,
  type StatementStagingFailureReason,
  StatementStagingId,
  type StatementSubmission,
  StatementSubmissionId,
  maximumOutstandingStatementSubmissions,
  maximumStatementBytes,
  maximumStatementStagingSweep,
  maximumStatementSubmissionsPerHour,
  statementParserRevision,
  statementStagingLifetimeMilliseconds,
  statementSubmissionRetentionMilliseconds,
} from "@fidy/server/statement-staging";
import {
  knownUnsupportedStatementBytes,
  statementSourceFormat,
} from "@fidy/server/statement-format";
import { CanonicalOperationId, type ErrorCode } from "@fidy/server/canonical-runtime";
import { recordRejectedPATWork } from "@fidy/server/tokens-runtime";
import {
  Context,
  Crypto,
  Data,
  DateTime,
  Effect,
  Encoding,
  Layer,
  Option,
  PlatformError,
  Schema,
} from "effect";
import { activeProUserParams, activeProUserSql } from "../access-tier";
import { sharedAuditLimitRefusal } from "../atomic/daily-canonical-budget";
import {
  type BoundedBodyReadFailed,
  collectBoundedRequestBody,
} from "../http/bounded-request-body";
import { prepareOwnedStatement } from "../pats/pat-unit";
import {
  type TransactionAuthority,
  acceptedPATAccountability,
  isPATAuthority,
} from "../transactions/transaction-boundary";

/** Versioned prefix for every statement object written by staging. */
const statementStagingObjectPrefix = "staging/statement/v1/";
const statementStagingObjectEntropyBytes = 32;
const millisecondsPerHour = 3_600_000;

/** Safe response vocabulary and metadata-only audit classification for statement publication. */
export type StatementPublicationRefusal = Readonly<{
  readonly code: ErrorCode;
  readonly auditOutcome: "not_found" | "validation_failed" | "resource_limit";
  readonly message: string;
}>;

type RefusalRecord = "recorded" | "credential_refused" | "rate_limited" | "unavailable";

/** The one-row assertion that rolls back a publication unit when a guarded step changed no row. */
export const statementSubmissionCompletion = `INSERT INTO statement_submission_assertion (id, accepted)
VALUES (1, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)
ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted`;

/**
 * Worker-backed entropy and digest for staging identities, object locators, and content digests.
 * Every adapter path draws both from this one Effect-producing boundary rather than ambient crypto.
 */
const workerCrypto = Crypto.make({
  randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    Effect.tryPromise({
      try: () =>
        crypto.subtle
          .digest(algorithm, Uint8Array.from(data))
          .then((bytes) => new Uint8Array(bytes)),
      catch: (cause) =>
        PlatformError.systemError({
          _tag: "Unknown",
          module: "WorkerCrypto",
          method: "digest",
          cause,
        }),
    }),
});

/**
 * The staging adapter refused a request or reference. Reasons are closed and safe: they never
 * carry statement bytes, a filename, a digest spelling, or platform detail.
 */
export class StatementStagingFailed extends Data.TaggedError("StatementStagingFailed")<{
  readonly reason: StatementStagingFailureReason;
}> {}

/** The staging adapter could not make a trustworthy decision; no domain state changed. */
export class StatementStagingUnavailable extends Data.TaggedError("StatementStagingUnavailable")<{
  readonly reason: "authority_unavailable";
}> {}

/**
 * One owner-prepared canonical statement publication, ready to join a caller-owned D1 unit. The
 * statements create the authoritative submission, reserve the Free backfill, promote the staged
 * material, record the metadata-only success Audit, publish the bounded extraction outbox identity,
 * and end with the caller's own accountability writes. `replayed` selects the replay accountability
 * writes an exact idempotent replay commits instead.
 */
export type PreparedStatementPublication = Readonly<{
  readonly attempt: PublicationAttempt;
  readonly operation: CanonicalOperationId;
  readonly replayed: boolean;
  readonly statements: ReadonlyArray<D1PreparedStatement>;
  readonly submissionId: string;
}>;

/** One bounded expired-staging cleanup result. */
export type StatementStagingSweep = Readonly<{
  readonly rowsDeleted: number;
  readonly objectsDeleted: number;
}>;

/** One bounded retention result: queued submissions failed with their material queued for cleanup. */
export type ExpiredStatementSubmissions = Readonly<{
  readonly submissionsFailed: number;
}>;

/** Stored lifecycle of one submission, exactly as the public projection needs it. */
export type StoredStatementSubmission = Readonly<{
  readonly id: string;
  readonly sourceFormat: "csv" | "xlsx";
  readonly parserRevision: string;
  readonly status: "queued" | "processing" | "completed" | "failed";
  readonly submittedAtMs: number;
  readonly startedAtMs: Option.Option<number>;
  readonly completedAtMs: Option.Option<number>;
  readonly failureReason: Option.Option<typeof StatementFailureReason.Type>;
  readonly inputRows: Option.Option<number>;
  readonly acceptedRows: Option.Option<number>;
  readonly needsReviewRows: Option.Option<number>;
}>;

/**
 * Bounded, User-scoped statement byte staging in private R2. Every operation receives an explicit
 * `userId` and constrains it in SQL; a staging id grants nothing on its own. Staging never creates
 * a StatementSubmission; canonical mutation preparation verifies the stored object before publication.
 */
export type StatementStagingService = Readonly<{
  /** Streams one bounded request body into private R2 and records non-authoritative staging state. */
  readonly stageStatementBytes: (input: {
    readonly userId: string;
    readonly request: Request;
  }) => Effect.Effect<StagedStatementBytes, StatementStagingFailed | StatementStagingUnavailable>;
  /** Reads bounded staged bytes only for the owning User; statement extraction is the caller. */
  readonly readOwnedStagedBytes: (input: {
    readonly userId: string;
    readonly stagingId: StatementStagingId;
  }) => Effect.Effect<Uint8Array, StatementStagingFailed | StatementStagingUnavailable>;
  /** Reads one owned submission's stored lifecycle for the canonical projection. */
  readonly readOwnedStatementSubmission: (input: {
    readonly userId: string;
    readonly submissionId: string;
  }) => Effect.Effect<Option.Option<StoredStatementSubmission>, StatementStagingUnavailable>;
  /**
   * Fails at most one bounded page of queued submissions past their retention bound, releases any
   * Free-backfill reservation they held, and queues their published material for the next staging
   * sweep. It never deletes the authoritative row.
   */
  readonly expireStatementSubmissions: Effect.Effect<
    ExpiredStatementSubmissions,
    StatementStagingUnavailable
  >;
  /** Deletes at most one bounded page of expired staging rows and their R2 objects. */
  readonly sweepExpiredStatementStaging: Effect.Effect<
    StatementStagingSweep,
    StatementStagingUnavailable
  >;
}>;

/** Trusted Worker-owned dependencies installed into one staging service. */
export type StatementStagingConfig = Readonly<{
  readonly database: D1Database;
  /** Private R2 binding; this module maps the binding's `null` absence into `Option` internally. */
  readonly bucket: R2Bucket;
  /** Worker clock seam. Request callers cannot choose decision time. */
  readonly nowEpochMs: () => number;
}>;

const StagingRow = Schema.Struct({
  id: Schema.String,
  object_key: Schema.String,
  byte_length: Schema.Int,
  sha256: Schema.String,
  source_format: Schema.NullOr(Schema.Literals(["csv", "xlsx"])),
  status: Schema.Literals(["pending", "available", "published", "deleting"]),
  expires_at_ms: Schema.Int,
});
type StagingRow = typeof StagingRow.Type;

const SubmissionRow = Schema.Struct({ id: Schema.String, staging_id: Schema.String });
type SubmissionRow = typeof SubmissionRow.Type;

/** One owned submission's stored lifecycle, read as the public projection's exact fields. */
const StoredSubmissionRow = Schema.Struct({
  accepted_rows: Schema.OptionFromNullOr(Schema.Int),
  completed_at_ms: Schema.OptionFromNullOr(Schema.Int),
  failure_reason: Schema.OptionFromNullOr(StatementFailureReason),
  id: Schema.String,
  input_rows: Schema.OptionFromNullOr(Schema.Int),
  needs_review_rows: Schema.OptionFromNullOr(Schema.Int),
  parser_revision: Schema.String,
  source_format: Schema.Literals(["csv", "xlsx"]),
  started_at_ms: Schema.OptionFromNullOr(Schema.Int),
  status: Schema.Literals(["queued", "processing", "completed", "failed"]),
  submitted_at_ms: Schema.Int,
});

/** Bounded publication-admission facts read in one D1 statement under the same binding. */
const AdmissionStateRow = Schema.Struct({
  outstanding: Schema.Int,
  recent: Schema.Int,
  backfill_reserved: Schema.Int,
  pro: Schema.Int,
});
type AdmissionStateRow = typeof AdmissionStateRow.Type;

const ExpiredRow = Schema.Struct({ id: Schema.String, object_key: Schema.String });
const ExpiredSubmissionRow = Schema.Struct({ id: Schema.String, staging_id: Schema.String });

const unavailable = (): StatementStagingUnavailable =>
  new StatementStagingUnavailable({ reason: "authority_unavailable" });

const failed = (reason: StatementStagingFailureReason): StatementStagingFailed =>
  new StatementStagingFailed({ reason });

/** One platform call whose failure is classified as an unavailable decision, never a refusal. */
const platformUnavailable = <A>(
  run: () => PromiseLike<A>
): Effect.Effect<A, StatementStagingUnavailable> =>
  Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: () => unavailable(),
  });

const isSafeEpoch = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

const newId = (): string => Effect.runSync(workerCrypto.randomUUIDv4.pipe(Effect.orDie));

/** Worker-generated random identity for one ingested statement record: a submission, audit, or
 * admission grant. It is never derived from User input, a digest, or a locator. */
export const newIngestionId = (): string => newId();

const randomObjectKey = (): string => {
  const entropy = Effect.runSync(
    workerCrypto.randomBytes(statementStagingObjectEntropyBytes).pipe(Effect.orDie)
  );
  return `${statementStagingObjectPrefix}${Encoding.encodeHex(entropy)}`;
};

const digestUnavailable = (
  bytes: Uint8Array
): Effect.Effect<ArrayBuffer, StatementStagingUnavailable> =>
  workerCrypto.digest("SHA-256", bytes).pipe(
    Effect.map((digest) => new Uint8Array(digest).buffer),
    Effect.mapError(() => unavailable())
  );

/**
 * Runs one D1 statement to settlement. D1 exposes no cancellation API, so shielding the promise
 * keeps an interrupted caller from detaching a still-running write from its durable outcome.
 */
const settleStatement = (
  statement: D1PreparedStatement
): Effect.Effect<D1Result<unknown>, StatementStagingUnavailable> =>
  Effect.uninterruptible(platformUnavailable(() => statement.run()));

/** Runs one returning D1 query to settlement, for statements whose rows are the answer. */
const settleAll = (
  statement: D1PreparedStatement
): Effect.Effect<D1Result<unknown>, StatementStagingUnavailable> =>
  Effect.uninterruptible(platformUnavailable(() => statement.all()));

const settleBatch = (
  database: D1Database,
  statements: ReadonlyArray<D1PreparedStatement>
): Effect.Effect<ReadonlyArray<D1Result<unknown>>, StatementStagingUnavailable> =>
  Effect.uninterruptible(platformUnavailable(() => database.batch([...statements])));

/** Finds one staging row for its owner only; another User's id is indistinguishable from a missing one. */
const findOwnedStagingRow = (
  database: D1Database,
  userId: string,
  stagingId: string
): Effect.Effect<Option.Option<StagingRow>, StatementStagingUnavailable> =>
  platformUnavailable(() =>
    database
      .prepare(
        `SELECT id, object_key, byte_length, sha256, source_format, status, expires_at_ms
         FROM statement_staging_objects WHERE id = ? AND user_id = ?`
      )
      .bind(stagingId, userId)
      .first()
  ).pipe(Effect.map((value) => Schema.decodeUnknownOption(StagingRow)(value)));

const findSubmissionByKey = (
  database: D1Database,
  userId: string,
  idempotencyKey: string
): Effect.Effect<Option.Option<SubmissionRow>, StatementStagingUnavailable> =>
  platformUnavailable(() =>
    database
      .prepare(
        `SELECT id, staging_id FROM statement_submissions
         WHERE user_id = ? AND idempotency_key = ?`
      )
      .bind(userId, idempotencyKey)
      .first()
  ).pipe(Effect.map((value) => Schema.decodeUnknownOption(SubmissionRow)(value)));

/** Marks one abandoned upload's row deleting before any object delete, so the bounded sweep can
 * always find the object again from durable state. */
const markStagingDeleting = (database: D1Database, stagingId: string): Effect.Effect<void> =>
  settleStatement(
    database
      .prepare(
        `UPDATE statement_staging_objects SET status = 'deleting'
         WHERE id = ? AND status IN ('pending', 'available') AND object_deleted_at_ms IS NULL`
      )
      .bind(stagingId)
  ).pipe(Effect.ignore);

/** Removes one sweepable staging row only after its object is gone. */
const removeDeletingStagingRow = (database: D1Database, stagingId: string): Effect.Effect<void> =>
  settleStatement(
    database
      .prepare("DELETE FROM statement_staging_objects WHERE id = ? AND status = 'deleting'")
      .bind(stagingId)
  ).pipe(Effect.ignore);

const ownedStagingRow = (
  config: StatementStagingConfig,
  userId: string,
  stagingId: string
): Effect.Effect<Option.Option<StagingRow>, StatementStagingUnavailable> =>
  findOwnedStagingRow(config.database, userId, stagingId);

const submissionByKey = (
  config: StatementStagingConfig,
  userId: string,
  idempotencyKey: string
): Effect.Effect<Option.Option<SubmissionRow>, StatementStagingUnavailable> =>
  findSubmissionByKey(config.database, userId, idempotencyKey);

/** Delete one staged object. A failed delete is a real failure: the caller keeps the durable
 * `deleting` row, so the bounded sweep retries instead of leaking an unreachable object. */
const removeObject = (
  bucket: R2Bucket,
  objectKey: string
): Effect.Effect<void, StatementStagingUnavailable> =>
  platformUnavailable(() => bucket.delete(objectKey));

const statementFailure = (reason: BoundedBodyReadFailed["reason"]): StatementStagingFailed => {
  if (reason === "resource-limit") return failed("resource-limit");
  if (reason === "cancelled") return failed("cancelled");
  return failed("malformed-file");
};

const readBoundedStatementBytes = (
  request: Request
): Effect.Effect<Uint8Array, StatementStagingFailed> =>
  collectBoundedRequestBody(request, maximumStatementBytes).pipe(
    Effect.mapError(({ reason }) => statementFailure(reason))
  );

const insertPendingStagingRow = (
  config: StatementStagingConfig,
  input: Readonly<{
    userId: string;
    stagingId: string;
    objectKey: string;
    byteLength: number;
    sha256: string;
    sourceFormat: string;
    createdAtEpochMs: number;
    expiresAtEpochMs: number;
  }>
): Effect.Effect<boolean, StatementStagingUnavailable> =>
  settleStatement(
    config.database
      .prepare(
        `INSERT INTO statement_staging_objects (
           id, user_id, object_key, byte_length, sha256, source_format, status,
           created_at_ms, expires_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .bind(
        input.stagingId,
        input.userId,
        input.objectKey,
        input.byteLength,
        input.sha256,
        input.sourceFormat,
        input.createdAtEpochMs,
        input.expiresAtEpochMs
      )
  ).pipe(Effect.map((result) => result.meta.changes === 1));

const writeStagingObject = (
  config: StatementStagingConfig,
  input: Readonly<{ objectKey: string; bytes: Uint8Array; digest: ArrayBuffer }>
): Effect.Effect<boolean, StatementStagingUnavailable> =>
  platformUnavailable(() =>
    config.bucket.put(input.objectKey, input.bytes, { sha256: input.digest })
  ).pipe(
    Effect.map(() => true),
    Effect.orElseSucceed(() => false)
  );

const markStagingAvailable = (
  config: StatementStagingConfig,
  stagingId: string
): Effect.Effect<boolean, StatementStagingUnavailable> =>
  settleStatement(
    config.database
      .prepare(
        `UPDATE statement_staging_objects SET status = 'available'
         WHERE id = ? AND status = 'pending'`
      )
      .bind(stagingId)
  ).pipe(Effect.map((result) => result.meta.changes === 1));

/** Reclaims one failed upload in sweep order: durable `deleting` row, object, then row. A failed
 * object delete leaves the row behind for the bounded sweep instead of an unreachable object. */
const discardStagedUpload = (
  config: StatementStagingConfig,
  input: Readonly<{ stagingId: string; objectKey: string }>
): Effect.Effect<void, StatementStagingUnavailable> =>
  Effect.gen(function* () {
    yield* markStagingDeleting(config.database, input.stagingId);
    yield* removeObject(config.bucket, input.objectKey);
    yield* removeDeletingStagingRow(config.database, input.stagingId);
  });

const stageStatementBytes = (
  config: StatementStagingConfig,
  input: Readonly<{ userId: string; request: Request }>
): ReturnType<StatementStagingService["stageStatementBytes"]> =>
  Effect.gen(function* () {
    const bytes = yield* readBoundedStatementBytes(input.request);
    if (bytes.byteLength === 0) return yield* failed("malformed-file");
    // Content, not a claimed name or media type, decides what may become durable staging state.
    if (knownUnsupportedStatementBytes(bytes)) return yield* failed("unsupported-format");
    const sourceFormat = statementSourceFormat(bytes);
    const digest = yield* digestUnavailable(bytes);
    const createdAtEpochMs = config.nowEpochMs();
    const expiresAtEpochMs = createdAtEpochMs + statementStagingLifetimeMilliseconds;
    if (!isSafeEpoch(createdAtEpochMs) || !isSafeEpoch(expiresAtEpochMs)) {
      return yield* unavailable();
    }
    const stagingId = newId();
    const objectKey = randomObjectKey();
    const sha256 = Encoding.encodeHex(new Uint8Array(digest));
    const pending = yield* insertPendingStagingRow(config, {
      byteLength: bytes.byteLength,
      createdAtEpochMs,
      expiresAtEpochMs,
      objectKey,
      sha256,
      sourceFormat,
      stagingId,
      userId: input.userId,
    });
    if (!pending) return yield* unavailable();
    if (!(yield* writeStagingObject(config, { bytes, digest, objectKey }))) {
      yield* discardStagedUpload(config, { objectKey, stagingId });
      return yield* unavailable();
    }
    if (!(yield* markStagingAvailable(config, stagingId))) {
      yield* discardStagedUpload(config, { objectKey, stagingId });
      return yield* unavailable();
    }
    return {
      stagingId: StatementStagingId.make(stagingId),
      byteLength: bytes.byteLength,
      sha256: StatementContentDigest.make(sha256),
      sourceFormat,
      expiresAt: DateTime.makeUnsafe(expiresAtEpochMs),
    };
  });

/**
 * A row that cannot be read at all, or a readable one with `None`. Pending and deleting material is
 * never readable; published material stays readable past staging expiry because the submission owns
 * its retention, so this intentionally differs from publication's `conflict` for published rows.
 */
const readRefusal = (
  row: StagingRow,
  nowEpochMs: number
): Option.Option<StatementStagingFailed> => {
  if (row.status === "pending" || row.status === "deleting") {
    return Option.some(failed("not-found"));
  }
  if (row.status === "available" && row.expires_at_ms <= nowEpochMs) {
    return Option.some(failed("retention-expired"));
  }
  return Option.none();
};

/**
 * Verifies the stored object's actual size and checksum without reading it, or returns the refusal.
 * The read path checks here first, so a substituted or oversized object is never buffered.
 */
const headStagedObject = (
  config: StatementStagingConfig,
  row: StagingRow
): Effect.Effect<Option.Option<StatementStagingFailed>, StatementStagingUnavailable> =>
  Effect.gen(function* () {
    const object = yield* platformUnavailable(() => config.bucket.head(row.object_key)).pipe(
      Effect.map(Option.fromNullishOr)
    );
    if (Option.isNone(object)) return Option.some(failed("not-found"));
    if (object.value.size !== row.byte_length) return Option.some(failed("malformed-file"));
    const checksum = Option.fromNullishOr(object.value.checksums.sha256);
    if (Option.isNone(checksum)) return yield* unavailable();
    return Encoding.encodeHex(new Uint8Array(checksum.value)) === row.sha256
      ? Option.none()
      : Option.some(failed("malformed-file"));
  });

const readStagedObjectBytes = (
  config: StatementStagingConfig,
  row: StagingRow
): Effect.Effect<Uint8Array, StatementStagingFailed | StatementStagingUnavailable> =>
  Effect.gen(function* () {
    const refusal = yield* headStagedObject(config, row);
    if (Option.isSome(refusal)) return yield* refusal.value;
    const object = yield* platformUnavailable(() => config.bucket.get(row.object_key)).pipe(
      Effect.map(Option.fromNullishOr)
    );
    if (Option.isNone(object) || !("arrayBuffer" in object.value)) {
      return yield* failed("not-found");
    }
    const body = object.value;
    return yield* platformUnavailable(() => body.arrayBuffer()).pipe(
      Effect.map((value) => new Uint8Array(value))
    );
  });

const readOwnedStagedBytes = (
  config: StatementStagingConfig,
  input: Readonly<{ userId: string; stagingId: StatementStagingId }>
): ReturnType<StatementStagingService["readOwnedStagedBytes"]> =>
  Effect.gen(function* () {
    const row = yield* ownedStagingRow(config, input.userId, input.stagingId);
    if (Option.isNone(row)) return yield* failed("not-found");
    const refusal = readRefusal(row.value, config.nowEpochMs());
    if (Option.isSome(refusal)) return yield* refusal.value;
    const bytes = yield* readStagedObjectBytes(config, row.value);
    if (bytes.byteLength !== row.value.byte_length) return yield* failed("malformed-file");
    const digest = yield* digestUnavailable(bytes);
    if (Encoding.encodeHex(new Uint8Array(digest)) !== row.value.sha256) {
      return yield* failed("malformed-file");
    }
    return bytes;
  });

/** Reads this User's submission and rolling-window admission pressure in one bounded statement. */
const readAdmissionState = (
  config: StatementStagingConfig,
  input: Readonly<{ userId: string; nowEpochMs: number }>
): Effect.Effect<Option.Option<AdmissionStateRow>, StatementStagingUnavailable> =>
  platformUnavailable(() =>
    config.database
      .prepare(
        `SELECT
           (SELECT count(*) FROM statement_submissions AS s
             WHERE s.user_id = ? AND s.status IN ('queued', 'processing')) AS outstanding,
           (SELECT count(*) FROM statement_submissions AS s
             WHERE s.user_id = ? AND s.submitted_at_ms > ?) AS recent,
           EXISTS (SELECT 1 FROM statement_backfill_entitlements AS e
             WHERE e.user_id = ? AND (e.consumed_at_ms IS NOT NULL OR e.submission_id IS NOT NULL))
             AS backfill_reserved,
           ${activeProUserSql} AS pro`
      )
      .bind(
        input.userId,
        input.userId,
        input.nowEpochMs - millisecondsPerHour,
        input.userId,
        ...activeProUserParams({ nowEpochMs: input.nowEpochMs, userId: input.userId })
      )
      .first()
  ).pipe(Effect.map((value) => Schema.decodeUnknownOption(AdmissionStateRow)(value)));

/** The closed refusal for exhausted submission pressure or a spent Free backfill, or `None`. */
const admissionRefusal = (
  state: AdmissionStateRow
): Option.Option<StatementStagingFailureReason> => {
  if (state.outstanding >= maximumOutstandingStatementSubmissions) {
    return Option.some("resource-limit");
  }
  if (state.recent >= maximumStatementSubmissionsPerHour) {
    return Option.some("resource-limit");
  }
  if (state.backfill_reserved !== 0 && state.pro === 0) {
    return Option.some("paywall");
  }
  return Option.none();
};

/** One publication unit's identity and decision instant, shared by its statements and classifiers. */
type PublicationAttempt = Readonly<{
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly stagingId: string;
  readonly nowEpochMs: number;
}>;

/**
 * The authoritative submission insert: every live precondition (ownership, availability, expiry,
 * sniffed format, idempotency, submission pressure, and the Free backfill) is re-checked inside the
 * one statement that creates authority, so a racing change can never admit a second submission.
 */
const submissionInsertStatement = (
  config: StatementStagingConfig,
  input: PublicationAttempt &
    Readonly<{
      authority: TransactionAuthority;
      submissionId: string;
      retentionExpiresAtEpochMs: number;
    }>
): D1PreparedStatement => {
  const { userId, idempotencyKey, stagingId, submissionId, nowEpochMs } = input;
  const hourStartEpochMs = nowEpochMs - millisecondsPerHour;
  return config.database
    .prepare(
      `INSERT INTO statement_submissions (
         id, user_id, idempotency_key, staging_id, source_format, parser_revision,
         service_market, locale, time_zone, status, submitted_at_ms, retention_expires_at_ms)
       SELECT ?, staging.user_id, ?, staging.id, staging.source_format, ?, users.service_market,
              users.locale, users.time_zone, 'queued', ?, ?
       FROM statement_staging_objects AS staging
       JOIN users ON users.id = staging.user_id
       WHERE staging.id = ? AND staging.user_id = ? AND staging.status = 'available'
         AND staging.expires_at_ms > ? AND staging.source_format IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM statement_submissions AS existing
           WHERE existing.user_id = ? AND existing.idempotency_key = ?)
         AND (SELECT count(*) FROM statement_submissions AS pending
               WHERE pending.user_id = staging.user_id
                 AND pending.status IN ('queued', 'processing'))
             < ?
         AND (SELECT count(*) FROM statement_submissions AS hourly
               WHERE hourly.user_id = staging.user_id AND hourly.submitted_at_ms > ?)
             < ?
         AND (${activeProUserSql} OR NOT EXISTS (
               SELECT 1 FROM statement_backfill_entitlements AS entitlement
               WHERE entitlement.user_id = staging.user_id
                 AND (entitlement.consumed_at_ms IS NOT NULL
                   OR entitlement.submission_id IS NOT NULL)))
         AND EXISTS (SELECT 1 FROM ${input.authority.table} WHERE ${input.authority.predicate})`
    )
    .bind(
      submissionId,
      idempotencyKey,
      statementParserRevision,
      nowEpochMs,
      input.retentionExpiresAtEpochMs,
      stagingId,
      userId,
      nowEpochMs,
      userId,
      idempotencyKey,
      maximumOutstandingStatementSubmissions,
      hourStartEpochMs,
      maximumStatementSubmissionsPerHour,
      ...activeProUserParams({ nowEpochMs, userId }),
      ...input.authority.bindings
    );
};

/** Metadata-only audit for one canonical read by its live session caller. The stable subject,
 * operation, outcome, and time are recorded; the submission body never enters the audit. A found
 * and an absent submission share this one row shape. PAT callers are audited in `pat_audit`. */
export const statementSubmissionReadAudit = ({
  authority,
  current,
  database,
  id,
  submissionId,
}: Readonly<{
  authority: TransactionAuthority;
  current: number;
  database: D1Database;
  id: string;
  submissionId: string;
}>): D1PreparedStatement =>
  database
    .prepare(
      `INSERT INTO statement_submission_audit (id, user_id, operation, outcome, occurred_at_ms)
       SELECT ?, ${authority.table}.user_id, 'ingestion.getStatementSubmission',
         CASE WHEN EXISTS (
           SELECT 1 FROM statement_submissions
           WHERE id = ? AND user_id = ${authority.table}.user_id
         ) THEN 'success' ELSE 'not_found' END, ?
       FROM ${authority.table} WHERE ${authority.predicate}`
    )
    .bind(id, submissionId, current, ...authority.bindings);

/**
 * The two outcomes a statement refusal audit can record. The closed publication refusal map already
 * answers every reason as `resource_limit` or `validation_failed`; narrowing through one total map
 * keeps that invariant checkable at the audit column's closed set, so an id a caller cannot prove
 * ownership of can never be recorded as `not_found`.
 */
const refusalAuditOutcome = (
  outcome: StatementPublicationRefusal["auditOutcome"]
): "resource_limit" | "validation_failed" =>
  outcome === "resource_limit" ? "resource_limit" : "validation_failed";

/** Metadata-only refusal audit for one canonical submission refusal by its live session caller, so
 * a refused call stays attributable without recording any submitted material. */
const statementSubmissionRefusalAudit = ({
  authority,
  current,
  database,
  id,
  outcome,
}: Readonly<{
  authority: TransactionAuthority;
  current: number;
  database: D1Database;
  id: string;
  outcome: "resource_limit" | "validation_failed";
}>): D1PreparedStatement =>
  database
    .prepare(
      `INSERT INTO statement_submission_audit (id, user_id, operation, outcome, occurred_at_ms)
       SELECT ?, ${authority.table}.user_id, 'ingestion.submitForExtraction', ?, ?
       FROM ${authority.table} WHERE ${authority.predicate}`
    )
    .bind(id, outcome, current, ...authority.bindings);

/** Metadata-only audit for one canonical submission replay by its live session caller: the stored
 * submission is returned unchanged, so the replay stays attributable without new authoritative
 * state. Its live-authority guard also refuses a credential revoked after dispatch. */
const statementSubmissionReplayAudit = ({
  authority,
  current,
  database,
  id,
}: Readonly<{
  authority: TransactionAuthority;
  current: number;
  database: D1Database;
  id: string;
}>): D1PreparedStatement =>
  database
    .prepare(
      `INSERT INTO statement_submission_audit (id, user_id, operation, outcome, occurred_at_ms)
       SELECT ?, ${authority.table}.user_id, 'ingestion.submitForExtraction', 'success', ?
       FROM ${authority.table} WHERE ${authority.predicate}`
    )
    .bind(id, current, ...authority.bindings);

/**
 * The guarded writes that own the staged material, the Free-backfill reservation, the
 * AuditLogEntry, and the bounded extraction outbox identity. Each changes a row only when the
 * previous step did, so the assertion that follows the caller's accountability writes can turn any
 * silently skipped step into a rolled-back unit. The outbox row this commits is the durable seam a
 * future extraction Workflow consumes with replay-safe identity (#805); this unit only ever writes
 * the identity and never does provider work itself.
 */
const publicationAccountabilityStatements = (
  config: StatementStagingConfig,
  input: PublicationAttempt & Readonly<{ submissionId: string; auditId: string }>
): ReadonlyArray<D1PreparedStatement> => {
  const { database } = config;
  const { userId, stagingId, submissionId, auditId, nowEpochMs } = input;
  const proParams = activeProUserParams({ nowEpochMs, userId });
  return [
    database
      .prepare(
        `UPDATE statement_staging_objects
         SET status = 'published', published_submission_id = ?
         WHERE id = ? AND user_id = ? AND status = 'available' AND expires_at_ms > ?
           AND changes() = 1`
      )
      .bind(submissionId, stagingId, userId, nowEpochMs),
    database
      .prepare(
        `INSERT INTO statement_backfill_entitlements (user_id, submission_id)
         SELECT ?, CASE WHEN ${activeProUserSql} THEN NULL ELSE ? END WHERE changes() = 1
         ON CONFLICT(user_id) DO UPDATE SET submission_id =
           CASE WHEN ${activeProUserSql} THEN statement_backfill_entitlements.submission_id
                ELSE excluded.submission_id END`
      )
      .bind(userId, ...proParams, submissionId, ...proParams),
    database
      .prepare(
        `INSERT INTO statement_submission_audit (id, user_id, operation, outcome, occurred_at_ms)
         SELECT ?, user_id, 'ingestion.submitForExtraction', 'success', ?
         FROM statement_submissions
         WHERE user_id = ? AND id = ? AND changes() = 1`
      )
      .bind(auditId, nowEpochMs, userId, submissionId),
    database
      .prepare(
        `INSERT INTO statement_ingestion_outbox (submission_id, user_id, revision, published_at_ms)
         SELECT id, user_id, 1, ? FROM statement_submissions
         WHERE user_id = ? AND id = ? AND changes() = 1`
      )
      .bind(nowEpochMs, userId, submissionId),
  ];
};

/**
 * The closed refusal for a row that cannot publish right now, or `None` when it can. Both the
 * non-committing precondition and the post-rollback classifier use it, so one staged state can never
 * map to two different reasons.
 */
const classifyStagedRow = (
  row: StagingRow,
  nowEpochMs: number
): Option.Option<StatementStagingFailureReason> => {
  if (row.status === "pending" || row.status === "deleting") return Option.some("not-found");
  if (row.status === "published") return Option.some("conflict");
  if (row.expires_at_ms <= nowEpochMs) return Option.some("retention-expired");
  if (row.source_format === null) return Option.some("unsupported-format");
  return Option.none();
};

/** The one canonical mutation this module publishes, with its staged-reference input. */
export const submitForExtraction = CanonicalOperationId.make("ingestion.submitForExtraction");

/** The one sentence a same-key material conflict is answered with, in every caller and suite. */
export const statementConflictMessage =
  "The idempotency key already names different statement material. Stage that material and use a new key.";

/** The one sentence every absent, foreign, or mismatched staged reference is answered with. */
export const stagedMaterialMessage =
  "The staged statement material is unavailable; upload the file again.";

/**
 * Every closed publication refusal as the bounded canonical failure the calling agent reads and the
 * metadata-only audit outcome it records. None carries statement content, a filename, a digest, or
 * platform detail, and the same code, message, and audit outcome answer a batch child. A missing or
 * foreign staged record is answered and recorded as `validation_failed`, never as `not_found`.
 */
const statementPublicationRefusals: Record<
  StatementStagingFailureReason,
  StatementPublicationRefusal
> = {
  cancelled: {
    auditOutcome: "validation_failed",
    code: "unavailable",
    message: "Canonical operation is temporarily unavailable.",
  },
  conflict: {
    auditOutcome: "validation_failed",
    code: "validation_failed",
    message: statementConflictMessage,
  },
  "malformed-file": {
    auditOutcome: "validation_failed",
    code: "validation_failed",
    message: stagedMaterialMessage,
  },
  "not-found": {
    auditOutcome: "validation_failed",
    code: "validation_failed",
    message: stagedMaterialMessage,
  },
  paywall: {
    auditOutcome: "resource_limit",
    code: "paywall_required",
    message:
      "This User has already used the lifetime Free statement backfill. Upgrade to Pro before submitting another statement.",
  },
  "resource-limit": {
    auditOutcome: "resource_limit",
    code: "validation_failed",
    message: "Finish existing statement extraction work before uploading another file.",
  },
  "retention-expired": {
    auditOutcome: "validation_failed",
    code: "validation_failed",
    message: stagedMaterialMessage,
  },
  "unsupported-format": {
    auditOutcome: "validation_failed",
    code: "validation_failed",
    message: stagedMaterialMessage,
  },
};

/** The canonical child-refusal contract for one closed publication refusal reason. */
export const statementRefusal = (
  reason: StatementStagingFailureReason
): StatementPublicationRefusal => statementPublicationRefusals[reason];

/** One submission's durable fields, decoded once from storage for the public projection. */
type SubmissionBase = Readonly<{
  readonly id: ReturnType<typeof StatementSubmissionId.make>;
  readonly parserRevision: string;
  readonly sourceFormat: "csv" | "xlsx";
  readonly submittedAt: DateTime.Utc;
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
export const submissionProjection = (
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

/**
 * The non-committing resolution of one staged reference: a ready publication, an exact
 * same-material replay, a closed refusal, or an unavailable authority. Ownership, the caller's
 * reference size and digest, availability, expiry, format, idempotency, submission pressure, the
 * Free backfill, and the stored object's actual size and checksum are verified here, so an
 * authoritative submission can never cite missing or mismatched bytes.
 */
export type StatementPublicationPreparation =
  | Readonly<{
      _tag: "Prepared";
      readonly publication: PreparedStatementPublication;
    }>
  | Readonly<{ _tag: "Refused"; readonly reason: StatementStagingFailureReason }>
  | Readonly<{ _tag: "Unavailable" }>;

/**
 * Credential-specific accountability that must commit inside one published statement unit: a PAT's
 * accepted AuditLogEntry and activity update, chained after the publication's own outbox identity.
 * A session publication writes its own success audit in the unit, so its list is empty.
 */
const statementPublicationAccountability = ({
  authority,
  current,
  database,
}: Readonly<{
  authority: TransactionAuthority;
  current: number;
  database: D1Database;
}>): ReadonlyArray<D1PreparedStatement> =>
  isPATAuthority(authority)
    ? acceptedPATAccountability({
        afterOwnerWrite: true,
        authority,
        current,
        database,
        operation: "ingestion.submitForExtraction",
      })
    : [];

/**
 * Credential-specific accountability a replayed statement call must commit instead of publishing
 * again: a PAT's accepted AuditLogEntry and activity update, or a session caller's one replay audit
 * row. Every statement is live-authority guarded, so a credential revoked after dispatch refuses
 * the replay rather than returning stored state.
 */
const statementReplayAccountability = ({
  authority,
  current,
  database,
}: Readonly<{
  authority: TransactionAuthority;
  current: number;
  database: D1Database;
}>): ReadonlyArray<D1PreparedStatement> =>
  isPATAuthority(authority)
    ? acceptedPATAccountability({
        afterOwnerWrite: false,
        authority,
        current,
        database,
        operation: "ingestion.submitForExtraction",
      })
    : [statementSubmissionReplayAudit({ authority, current, database, id: newId() })];

/**
 * One existing submission as the exact replay this call must commit instead of publishing again.
 * The replay's live-authority-guarded accountability is what makes an idempotent retry and a lost
 * same-material race attributable; neither re-runs a child decision nor changes authoritative state.
 */
const replayPublication = (
  config: StatementStagingConfig,
  input: Readonly<{
    authority: TransactionAuthority;
    attempt: PublicationAttempt;
    current: number;
    submissionId: string;
  }>
): PreparedStatementPublication => ({
  attempt: input.attempt,
  operation: submitForExtraction,
  replayed: true,
  statements: statementReplayAccountability({
    authority: input.authority,
    current: input.current,
    database: config.database,
  }),
  submissionId: input.submissionId,
});

/**
 * The authoritative publication one admitted staged row commits: the submission, its promotion,
 * the Free-backfill reservation, the metadata-only success Audit, and the bounded extraction
 * outbox identity, ending in the caller's own credential accountability.
 */
const readyPublication = (
  config: StatementStagingConfig,
  input: Readonly<{
    attempt: PublicationAttempt;
    authority: TransactionAuthority;
    submissionId: string;
  }>
): PreparedStatementPublication => ({
  attempt: input.attempt,
  operation: submitForExtraction,
  replayed: false,
  statements: [
    submissionInsertStatement(config, {
      ...input.attempt,
      authority: input.authority,
      retentionExpiresAtEpochMs:
        input.attempt.nowEpochMs + statementSubmissionRetentionMilliseconds,
      submissionId: input.submissionId,
    }),
    ...publicationAccountabilityStatements(config, {
      ...input.attempt,
      auditId: newId(),
      submissionId: input.submissionId,
    }),
    ...statementPublicationAccountability({
      authority: input.authority,
      current: input.attempt.nowEpochMs,
      database: config.database,
    }),
  ],
  submissionId: input.submissionId,
});

/** One key that already names a submission: its exact replay, or the conflict of other material. */
const existingPublication = (
  config: StatementStagingConfig,
  input: Readonly<{
    authority: TransactionAuthority;
    attempt: PublicationAttempt;
    existing: SubmissionRow;
    stagingId: string;
  }>
): StatementPublicationPreparation =>
  input.existing.staging_id === input.stagingId
    ? {
        _tag: "Prepared",
        publication: replayPublication(config, {
          attempt: input.attempt,
          authority: input.authority,
          current: input.attempt.nowEpochMs,
          submissionId: input.existing.id,
        }),
      }
    : { _tag: "Refused", reason: "conflict" };

type PublicationPremise =
  | Readonly<{ _tag: "Ready" }>
  | Readonly<{ _tag: "Refused"; reason: StatementStagingFailureReason }>
  | Readonly<{ _tag: "Unavailable" }>;

/**
 * The premise every classification of one owned staged row shares: its own state and the User's
 * admission pressure, as a closed refusal, an unreadable admission, or `Holds` when the row still
 * admits publication. The object check stays with the caller: only a preparation that will commit
 * needs the staged bytes to be present, while a post-abort classification must not depend on R2.
 */
const premiseDecision = (
  config: StatementStagingConfig,
  input: Readonly<{ attempt: PublicationAttempt; row: StagingRow }>
): Effect.Effect<
  | Readonly<{ _tag: "Refused"; reason: StatementStagingFailureReason }>
  | Readonly<{ _tag: "Unavailable" }>
  | Readonly<{ _tag: "Holds" }>,
  StatementStagingUnavailable
> =>
  Effect.gen(function* () {
    const refusal = classifyStagedRow(input.row, input.attempt.nowEpochMs);
    if (Option.isSome(refusal)) return { _tag: "Refused", reason: refusal.value } as const;
    const admission = yield* readAdmissionState(config, {
      nowEpochMs: input.attempt.nowEpochMs,
      userId: input.attempt.userId,
    });
    if (Option.isNone(admission)) return { _tag: "Unavailable" } as const;
    const pressure = admissionRefusal(admission.value);
    return Option.isSome(pressure)
      ? ({ _tag: "Refused", reason: pressure.value } as const)
      : ({ _tag: "Holds" } as const);
  });

/** The non-committing premise of one admitted staged row: ready, a closed refusal, or unreadable. */
const publicationPremise = (
  config: StatementStagingConfig,
  input: Readonly<{ attempt: PublicationAttempt; row: StagingRow }>
): Effect.Effect<PublicationPremise, StatementStagingUnavailable> =>
  Effect.gen(function* () {
    const decision = yield* premiseDecision(config, input);
    if (decision._tag !== "Holds") return decision;
    const objectRefusal = yield* headStagedObject(config, input.row);
    return Option.isSome(objectRefusal)
      ? ({ _tag: "Refused", reason: objectRefusal.value.reason } as const)
      : ({ _tag: "Ready" } as const);
  });

/**
 * Resolve one owner-held staged reference into a non-committing publication preparation a caller
 * composes into its own D1 unit, or a closed refusal. It verifies ownership, the reference's actual
 * size and digest, availability, expiry, format, idempotency, submission pressure, the Free
 * backfill, and the stored object's own size and checksum, so nothing that reaches a unit can cite
 * missing or mismatched material.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const prepareStagedStatementPublication = (
  config: StatementStagingConfig,
  input: Readonly<{
    readonly authority: TransactionAuthority;
    readonly current: number;
    readonly idempotencyKey: string;
    readonly reference: StagedStatementReference;
    readonly userId: string;
  }>
): Effect.Effect<StatementPublicationPreparation, StatementStagingUnavailable> =>
  Effect.gen(function* () {
    const row = yield* ownedStagingRow(config, input.userId, input.reference.stagingId);
    if (Option.isNone(row)) return { _tag: "Refused", reason: "not-found" } as const;
    if (
      row.value.byte_length !== input.reference.byteLength ||
      row.value.sha256 !== input.reference.sha256
    ) {
      return { _tag: "Refused", reason: "malformed-file" } as const;
    }
    const attempt: PublicationAttempt = {
      idempotencyKey: input.idempotencyKey,
      nowEpochMs: input.current,
      stagingId: row.value.id,
      userId: input.userId,
    };
    const existing = yield* submissionByKey(config, input.userId, input.idempotencyKey);
    if (Option.isSome(existing)) {
      return existingPublication(config, {
        attempt,
        authority: input.authority,
        existing: existing.value,
        stagingId: row.value.id,
      });
    }
    const premise = yield* publicationPremise(config, { attempt, row: row.value });
    if (premise._tag !== "Ready") return premise;
    const submissionId = newId();
    return {
      _tag: "Prepared",
      publication: readyPublication(config, {
        attempt,
        authority: input.authority,
        submissionId,
      }),
    } as const;
  });

/**
 * Records one refused canonical statement call's metadata-only AuditLogEntry under the exact
 * authority the caller presented: a PAT's rejected `pat_audit` row, or a session caller's bounded
 * `statement_submission_audit` refusal. A refusal whose audit cannot commit for a dead credential, a
 * spent shared daily budget, or an unavailable authority is classified instead of answered.
 */
export const recordStatementRefusal = (
  input: Readonly<{
    readonly authority: TransactionAuthority;
    readonly current: number;
    readonly database: D1Database;
    readonly refusal: StatementPublicationRefusal;
  }>
): Promise<RefusalRecord> =>
  input.database
    .batch([
      isPATAuthority(input.authority)
        ? prepareOwnedStatement({
            db: input.database,
            statement: recordRejectedPATWork({
              authority: input.authority,
              input: {
                current: input.current,
                id: newId(),
                operation: "ingestion.submitForExtraction",
              },
            }),
          })
        : statementSubmissionRefusalAudit({
            authority: input.authority,
            current: input.current,
            database: input.database,
            id: newId(),
            outcome: refusalAuditOutcome(input.refusal.auditOutcome),
          }),
    ])
    .then((results): RefusalRecord =>
      results[0]?.meta.changes === 1 ? "recorded" : "credential_refused"
    )
    .catch((cause: unknown) =>
      sharedAuditLimitRefusal(cause) ? ("rate_limited" as const) : ("unavailable" as const)
    );

type LostPublication =
  | Readonly<{ _tag: "Replay"; submissionId: string }>
  | Readonly<{ _tag: "Refused"; reason: StatementStagingFailureReason }>
  | Readonly<{ _tag: "Unavailable" }>
  | Readonly<{ _tag: "Unattributable" }>;

/**
 * Classifies a publication whose conditional D1 unit lost: a concurrent call that published the
 * same material under the same key is an exact replay, a premise that moved outside the unit is a
 * closed refusal, and a defect is unavailable rather than an invented refusal.
 */
const classifyLostPublication = (
  config: StatementStagingConfig,
  input: Readonly<{ attempt: PublicationAttempt }>
): Effect.Effect<LostPublication, StatementStagingUnavailable> =>
  Effect.gen(function* () {
    const existing = yield* submissionByKey(
      config,
      input.attempt.userId,
      input.attempt.idempotencyKey
    );
    if (Option.isSome(existing)) {
      return existing.value.staging_id === input.attempt.stagingId
        ? ({ _tag: "Replay", submissionId: existing.value.id } as const)
        : ({ _tag: "Refused", reason: "conflict" } as const);
    }
    const row = yield* ownedStagingRow(config, input.attempt.userId, input.attempt.stagingId);
    if (Option.isNone(row)) return { _tag: "Refused", reason: "not-found" } as const;
    const decision = yield* premiseDecision(config, { attempt: input.attempt, row: row.value });
    return decision._tag === "Holds" ? ({ _tag: "Unattributable" } as const) : decision;
  });

/** Whether an aborted, previously fresh publication now has the exact same-key material committed. */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const lostStatementReplay = (
  config: StatementStagingConfig,
  publication: PreparedStatementPublication
): Effect.Effect<boolean> =>
  publication.replayed
    ? Effect.succeed(false)
    : classifyLostPublication(config, { attempt: publication.attempt }).pipe(
        Effect.map((lost) => lost._tag === "Replay"),
        Effect.orElseSucceed(() => false)
      );

/** A changed publication premise that the durable state proves caused an aborted unit. */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const statementAbortRefusal = (
  config: StatementStagingConfig,
  publication: PreparedStatementPublication
): Effect.Effect<Option.Option<StatementPublicationRefusal>> =>
  publication.replayed
    ? Effect.succeedNone
    : classifyLostPublication(config, { attempt: publication.attempt }).pipe(
        Effect.map((lost) =>
          lost._tag === "Refused" ? Option.some(statementRefusal(lost.reason)) : Option.none()
        ),
        Effect.orElseSucceed(() => Option.none())
      );

// @effect-diagnostics-next-line missingPipeableSignature:off
export const readOwnedStatementSubmission = (
  config: StatementStagingConfig,
  input: Readonly<{ userId: string; submissionId: string }>
): ReturnType<StatementStagingService["readOwnedStatementSubmission"]> =>
  platformUnavailable(() =>
    config.database
      .prepare(
        `SELECT id, source_format, parser_revision, status, submitted_at_ms, started_at_ms,
                completed_at_ms, failure_reason, input_rows, accepted_rows, needs_review_rows
         FROM statement_submissions WHERE id = ? AND user_id = ?`
      )
      .bind(input.submissionId, input.userId)
      .first()
  ).pipe(
    Effect.map((value) =>
      Option.map(
        Schema.decodeUnknownOption(StoredSubmissionRow)(value),
        (row): StoredStatementSubmission => ({
          acceptedRows: row.accepted_rows,
          completedAtMs: row.completed_at_ms,
          failureReason: row.failure_reason,
          id: row.id,
          inputRows: row.input_rows,
          needsReviewRows: row.needs_review_rows,
          parserRevision: row.parser_revision,
          sourceFormat: row.source_format,
          startedAtMs: row.started_at_ms,
          status: row.status,
          submittedAtMs: row.submitted_at_ms,
        })
      )
    )
  );

const expireStatementSubmissions = (
  config: StatementStagingConfig
): Effect.Effect<ExpiredStatementSubmissions, StatementStagingUnavailable> =>
  Effect.gen(function* () {
    const nowEpochMs = config.nowEpochMs();
    if (!isSafeEpoch(nowEpochMs)) return yield* unavailable();
    const candidates = yield* settleAll(
      config.database
        .prepare(
          `SELECT id, staging_id FROM statement_submissions
           WHERE status IN ('queued', 'processing') AND retention_expires_at_ms <= ?
           ORDER BY retention_expires_at_ms LIMIT ?`
        )
        .bind(nowEpochMs, maximumStatementStagingSweep)
    );
    const rows = candidates.results.flatMap((value) =>
      Option.match(Schema.decodeUnknownOption(ExpiredSubmissionRow)(value), {
        onNone: () => [],
        onSome: (row) => [row],
      })
    );
    if (rows.length === 0) return { submissionsFailed: 0 };
    const placeholders = rows.map(() => "?").join(", ");
    const ids = rows.map(({ id }) => id);
    const stagingIds = rows.map(({ staging_id: stagingId }) => stagingId);
    const stagingPlaceholders = stagingIds.map(() => "?").join(", ");
    const results = yield* settleBatch(config.database, [
      // The terminal transition commits before any object delete, so no authoritative submission
      // that still lacks a useful outcome can ever point at material a later cleanup run reclaimed.
      config.database
        .prepare(
          `UPDATE statement_submissions
           SET status = 'failed', started_at_ms = coalesce(started_at_ms, ?),
               completed_at_ms = ?, failure_reason = 'retention-expired'
           WHERE id IN (${placeholders}) AND status IN ('queued', 'processing')`
        )
        .bind(nowEpochMs, nowEpochMs, ...ids),
      // A submission that never produced a useful outcome returns the Free backfill to the User.
      config.database
        .prepare(
          `UPDATE statement_backfill_entitlements SET submission_id = NULL
           WHERE consumed_at_ms IS NULL AND submission_id IN (${placeholders})`
        )
        .bind(...ids),
      // Published material becomes sweepable exactly once; the sweep deletes the object and keeps
      // the referenced row as durable evidence that the locator's bytes are gone. Clearing the
      // publication pointer is what lets the row leave `published` under the staging state check.
      config.database
        .prepare(
          `UPDATE statement_staging_objects
           SET status = 'deleting', published_submission_id = NULL
           WHERE id IN (${stagingPlaceholders}) AND status = 'published'
             AND object_deleted_at_ms IS NULL`
        )
        .bind(...stagingIds),
    ]);
    return { submissionsFailed: results[0]?.meta.changes ?? 0 };
  });

const sweepExpiredStatementStaging = (
  config: StatementStagingConfig
): Effect.Effect<StatementStagingSweep, StatementStagingUnavailable> =>
  Effect.gen(function* () {
    const nowEpochMs = config.nowEpochMs();
    if (!isSafeEpoch(nowEpochMs)) return yield* unavailable();
    // One bounded D1 statement moves expired unpublished rows to `deleting`, so a publication can
    // never commit against material whose object delete is pending: D1 serializes this against the
    // publication unit, and `deleting` rows are refused. Objects are deleted next and rows last;
    // an interrupted sweep re-selects its `deleting` rows, so no object is left unreachable.
    const marked = yield* settleAll(
      config.database
        .prepare(
          `UPDATE statement_staging_objects SET status = 'deleting'
           WHERE id IN (
             SELECT id FROM statement_staging_objects
             WHERE status != 'published' AND object_deleted_at_ms IS NULL AND expires_at_ms <= ?
             ORDER BY expires_at_ms
             LIMIT ?
           )
           RETURNING id, object_key`
        )
        .bind(nowEpochMs, maximumStatementStagingSweep)
    );
    const rows = marked.results.flatMap((value) =>
      Option.match(Schema.decodeUnknownOption(ExpiredRow)(value), {
        onNone: () => [],
        onSome: (row) => [row],
      })
    );
    if (rows.length === 0) return { objectsDeleted: 0, rowsDeleted: 0 };
    yield* platformUnavailable(() =>
      config.bucket.delete(rows.map(({ object_key: objectKey }) => objectKey))
    );
    const placeholders = rows.map(() => "?").join(", ");
    const ids = rows.map(({ id }) => id);
    const results = yield* settleBatch(config.database, [
      // Rows a submission still references stay as durable cleanup evidence; only the object goes.
      config.database
        .prepare(
          `DELETE FROM statement_staging_objects
           WHERE id IN (${placeholders}) AND status = 'deleting'
             AND NOT EXISTS (
               SELECT 1 FROM statement_submissions
               WHERE staging_id = statement_staging_objects.id)`
        )
        .bind(...ids),
      config.database
        .prepare(
          `UPDATE statement_staging_objects SET object_deleted_at_ms = ?
           WHERE id IN (${placeholders}) AND status = 'deleting' AND object_deleted_at_ms IS NULL
             AND EXISTS (
               SELECT 1 FROM statement_submissions
               WHERE staging_id = statement_staging_objects.id)`
        )
        .bind(nowEpochMs, ...ids),
    ]);
    return { objectsDeleted: rows.length, rowsDeleted: results[0]?.meta.changes ?? 0 };
  });

const makeStatementStagingService = (config: StatementStagingConfig): StatementStagingService => ({
  expireStatementSubmissions: expireStatementSubmissions(config),
  readOwnedStatementSubmission: (input) => readOwnedStatementSubmission(config, input),
  readOwnedStagedBytes: (input) => readOwnedStagedBytes(config, input),
  stageStatementBytes: (input) => stageStatementBytes(config, input),
  sweepExpiredStatementStaging: sweepExpiredStatementStaging(config),
});

/** Substitutable private-R2 statement staging assembled by the private Core Worker. */
export class StatementStaging extends Context.Service<StatementStaging, StatementStagingService>()(
  "@fidy/server/cloudflare/ingestion/statement-staging/StatementStaging"
) {
  /** Constructs a staging value for direct Worker adapter composition. */
  static readonly make = (config: StatementStagingConfig): StatementStagingService =>
    this.of(makeStatementStagingService(config));

  /** Primary production layer parameterized by the Core Worker's D1 and R2 bindings. */
  static readonly layer = (config: StatementStagingConfig): Layer.Layer<StatementStaging> =>
    Layer.succeed(this, this.make(config));
}
