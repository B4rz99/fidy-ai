import {
  type StagedStatementBytes,
  type StagedStatementReference,
  StagedStatementReference as StagedStatementReferenceSchema,
  StatementContentDigest,
  StatementFailureReason,
  type StatementStagingFailureReason,
  StatementStagingId,
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
import type * as Arr from "effect/Array";
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
  Result,
  Schema,
} from "effect";
import { activeProUserParams, activeProUserSql } from "../access-tier";
import {
  type BoundedBodyReadFailed,
  collectBoundedRequestBody,
} from "../http/bounded-request-body";
import type { TransactionAuthority } from "../transactions/transaction-boundary";

/** Versioned prefix for every statement object written by staging. */
const statementStagingObjectPrefix = "staging/statement/v1/";
const statementStagingObjectEntropyBytes = 32;
const millisecondsPerHour = 3_600_000;
/** Stable SQLite constraint name that marks one refused conditional publication unit. */
const statementSubmissionRefusalMarker = "statement_submission_refused";
/** Stable SQLite abort message the shared stable-User daily canonical work budget raises. */
export const statementAuditLimitMarker = "statement_audit_limit";

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

/** The canonical call was refused by its own dead authority or the shared daily work budget. */
export class StatementStagingRefused extends Data.TaggedError("StatementStagingRefused")<{
  readonly reason: "authority" | "budget";
}> {}

/** One non-empty, read-only batch of caller-owned accountability statements. */
export type ReplayStatements = Readonly<Arr.NonEmptyArray<D1PreparedStatement>>;

/** One D1 publication unit that failed; its cause is inspected only for a known refusal marker. */
class StatementPublicationBatchFailed extends Data.TaggedError("StatementPublicationBatchFailed")<{
  readonly cause: unknown;
}> {}

/** Durable identity of one published submission, with whether this call replayed an earlier one. */
export type PublishedStatementSubmission = Readonly<{
  readonly submissionId: string;
  readonly replayed: boolean;
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
 * Bounded, User-scoped statement byte staging in private R2 plus the single D1 publication that
 * makes staged material authoritative. Every operation receives an explicit `userId` and constrains
 * it in SQL; a staging id grants nothing on its own. Staging never creates a StatementSubmission,
 * and publication verifies the stored object's actual size and digest before its D1 atomic unit.
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
  /**
   * Publishes one authoritative D1 submission for an owned, unexpired, digest-verified staged
   * object, together with its AuditLogEntry, Free-backfill reservation, and extraction outbox
   * identity. A replay of the same idempotency key returns the original submission; the same key
   * pointing at different material is a conflict. `authority` is the caller's live credential gate,
   * rechecked inside the unit so a credential revoked after dispatch cannot publish. `statements`
   * are caller-owned, guard-chained accountability writes (for example PAT Audit) that commit inside
   * the same unit or not at all. `replayStatements` are the caller-owned writes a replayed call
   * must commit instead: every one is live-authority guarded and must change exactly one row, so a
   * credential revoked after dispatch refuses the replay rather than returning stored state.
   */
  readonly publishStagedStatementSubmission: (input: {
    readonly userId: string;
    readonly idempotencyKey: string;
    readonly reference: StagedStatementReference;
    readonly authority: TransactionAuthority;
    readonly statements: ReadonlyArray<D1PreparedStatement>;
    readonly replayStatements: ReplayStatements;
  }) => Effect.Effect<
    PublishedStatementSubmission,
    StatementStagingFailed | StatementStagingRefused | StatementStagingUnavailable
  >;
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

/** Metadata-only refusal audit for one canonical submission refusal by its live session caller, so
 * a refused call stays attributable without recording any submitted material. */
export const statementSubmissionRefusalAudit = ({
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
export const statementSubmissionReplayAudit = ({
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
 * silently skipped step into a rolled-back unit.
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

type PublicationPrecondition =
  | Readonly<{ _tag: "Publish"; row: StagingRow }>
  | Readonly<{ _tag: "Replay"; publication: PublishedStatementSubmission }>
  | Readonly<{ _tag: "Refused"; failure: StatementStagingFailed }>
  | Readonly<{ _tag: "Unavailable" }>;

/**
 * The closed refusal for a row that cannot publish right now, or `None` when it can. Both the
 * non-committing precondition and the post-batch classifier use it, so one staged state can never
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

const replayOrConflict = (existing: SubmissionRow, stagingId: string): PublicationPrecondition =>
  existing.staging_id === stagingId
    ? { _tag: "Replay", publication: { replayed: true, submissionId: existing.id } }
    : { _tag: "Refused", failure: failed("conflict") };

/**
 * Resolves the one non-committing outcome for a reference: publishable, an exact replay, or a
 * closed refusal. The caller reference is verified against the stored row before any replay
 * decision, so a tampered digest or size is never reported as accepted or replayed.
 */
const readPublicationPrecondition = (
  config: StatementStagingConfig,
  input: Readonly<{
    userId: string;
    idempotencyKey: string;
    reference: StagedStatementReference;
    nowEpochMs: number;
  }>
): Effect.Effect<PublicationPrecondition, StatementStagingUnavailable> =>
  Effect.gen(function* () {
    const row = yield* ownedStagingRow(config, input.userId, input.reference.stagingId);
    if (Option.isNone(row)) return { _tag: "Refused", failure: failed("not-found") };
    if (
      row.value.byte_length !== input.reference.byteLength ||
      row.value.sha256 !== input.reference.sha256
    ) {
      return { _tag: "Refused", failure: failed("malformed-file") };
    }
    const existing = yield* submissionByKey(config, input.userId, input.idempotencyKey);
    if (Option.isSome(existing)) {
      return replayOrConflict(existing.value, row.value.id);
    }
    const refusal = classifyStagedRow(row.value, input.nowEpochMs);
    if (Option.isSome(refusal)) return { _tag: "Refused", failure: failed(refusal.value) };
    const admission = yield* readAdmissionState(config, {
      nowEpochMs: input.nowEpochMs,
      userId: input.userId,
    });
    if (Option.isNone(admission)) return { _tag: "Unavailable" };
    const pressure = admissionRefusal(admission.value);
    return Option.isSome(pressure)
      ? { _tag: "Refused", failure: failed(pressure.value) }
      : { _tag: "Publish", row: row.value };
  });

/**
 * Classifies a publication that lost its conditional D1 unit. A concurrent replay of the same
 * material is success; anything else is a closed refusal, never a partial write.
 */
const classifyUnpublished = (
  config: StatementStagingConfig,
  input: Readonly<{
    userId: string;
    idempotencyKey: string;
    stagingId: string;
    nowEpochMs: number;
  }>
): Effect.Effect<
  PublishedStatementSubmission,
  StatementStagingFailed | StatementStagingUnavailable
> =>
  Effect.gen(function* () {
    const existing = yield* submissionByKey(config, input.userId, input.idempotencyKey);
    if (Option.isSome(existing)) {
      return existing.value.staging_id === input.stagingId
        ? { replayed: true, submissionId: existing.value.id }
        : yield* failed("conflict");
    }
    const row = yield* ownedStagingRow(config, input.userId, input.stagingId);
    if (Option.isNone(row)) return yield* failed("not-found");
    const refusal = classifyStagedRow(row.value, input.nowEpochMs);
    if (Option.isSome(refusal)) return yield* failed(refusal.value);
    const admission = yield* readAdmissionState(config, {
      nowEpochMs: input.nowEpochMs,
      userId: input.userId,
    });
    if (Option.isNone(admission)) return yield* unavailable();
    const pressure = admissionRefusal(admission.value);
    if (Option.isSome(pressure)) return yield* failed(pressure.value);
    return yield* failed("conflict");
  });

type PublicationUnitOutcome =
  | Readonly<{ _tag: "Settled"; results: ReadonlyArray<D1Result<unknown>> }>
  | Readonly<{ _tag: "Refused" }>
  | Readonly<{ _tag: "BudgetSpent" }>
  | Readonly<{ _tag: "Unavailable" }>;

/**
 * Runs the complete guard-chained publication unit in one D1 batch. A zero-row guard trips the
 * final assertion, which rolls the unit back and is recognized here as a refusal; any other failure
 * stays an unavailable authority rather than being reported as a domain decision.
 */
const publicationUnitOutcome = (
  config: StatementStagingConfig,
  input: Readonly<{
    attempt: PublicationAttempt;
    authority: TransactionAuthority;
    submissionId: string;
    statements: ReadonlyArray<D1PreparedStatement>;
  }>
): Effect.Effect<PublicationUnitOutcome> =>
  Effect.result(
    Effect.uninterruptible(
      Effect.tryPromise({
        try: () =>
          config.database.batch([
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
            ...input.statements,
            config.database.prepare(statementSubmissionCompletion),
          ]),
        catch: (cause) => new StatementPublicationBatchFailed({ cause }),
      })
    )
  ).pipe(
    Effect.map((result): PublicationUnitOutcome => {
      if (Result.isSuccess(result)) return { _tag: "Settled", results: result.success };
      if (String(result.failure.cause).includes(statementAuditLimitMarker)) {
        return { _tag: "BudgetSpent" };
      }
      return String(result.failure.cause).includes(statementSubmissionRefusalMarker)
        ? { _tag: "Refused" }
        : { _tag: "Unavailable" };
    })
  );

type PublicationResolution =
  | Readonly<{ _tag: "Ready"; reference: StagedStatementReference; nowEpochMs: number }>
  | Readonly<{ _tag: "Replay"; publication: PublishedStatementSubmission }>
  | Readonly<{ _tag: "Refused"; failure: StatementStagingFailed }>
  | Readonly<{ _tag: "Unavailable" }>;

/**
 * Resolves one reference into a ready publication or a closed refusal, verifying the stored object's
 * actual size and digest before the atomic unit is attempted.
 */
const resolvePublication = (
  config: StatementStagingConfig,
  input: Readonly<{
    userId: string;
    idempotencyKey: string;
    reference: StagedStatementReference;
  }>
): Effect.Effect<PublicationResolution, StatementStagingUnavailable> =>
  Effect.gen(function* () {
    const nowEpochMs = config.nowEpochMs();
    const precondition = yield* readPublicationPrecondition(config, {
      idempotencyKey: input.idempotencyKey,
      nowEpochMs,
      reference: input.reference,
      userId: input.userId,
    });
    if (precondition._tag === "Replay") {
      return { _tag: "Replay", publication: precondition.publication };
    }
    if (precondition._tag === "Unavailable") return { _tag: "Unavailable" };
    if (precondition._tag === "Refused") {
      return { _tag: "Refused", failure: precondition.failure };
    }
    const refusal = yield* headStagedObject(config, precondition.row);
    if (Option.isSome(refusal)) return { _tag: "Refused", failure: refusal.value };
    return { _tag: "Ready", nowEpochMs, reference: input.reference };
  });

/**
 * Settles one replayed call: its caller-owned attribution writes must commit, each changing exactly
 * one row under a live-authority guard. A write refused by a dead credential or a spent shared
 * daily budget refuses the call, so the stored submission is never returned unattributed.
 */
const replayOutcome = (
  config: StatementStagingConfig,
  input: Readonly<{
    publication: PublishedStatementSubmission;
    statements: ReplayStatements;
  }>
): ReturnType<StatementStagingService["publishStagedStatementSubmission"]> =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      Effect.uninterruptible(
        Effect.tryPromise({
          try: () => config.database.batch([...input.statements]),
          catch: (cause) => new StatementPublicationBatchFailed({ cause }),
        })
      )
    );
    if (Result.isFailure(result)) {
      if (String(result.failure.cause).includes(statementAuditLimitMarker)) {
        return yield* new StatementStagingRefused({ reason: "budget" });
      }
      return yield* unavailable();
    }
    if (!result.success.every((statement) => statement.meta.changes === 1)) {
      return yield* new StatementStagingRefused({ reason: "authority" });
    }
    return input.publication;
  });

/**
 * Turns one settled unit into the published submission, or the refusal its guards prove. A lost
 * race that classifies as a same-material replay still commits the caller-owned attribution the
 * winning call's unit could not: the call is never returned unaudited or ungated.
 */
const publicationOutcome = (
  config: StatementStagingConfig,
  input: Readonly<{
    attempt: PublicationAttempt;
    outcome: PublicationUnitOutcome;
    replayStatements: ReplayStatements;
    submissionId: string;
  }>
): ReturnType<StatementStagingService["publishStagedStatementSubmission"]> => {
  if (input.outcome._tag === "Unavailable") return unavailable();
  if (input.outcome._tag === "BudgetSpent") {
    return Effect.fail(new StatementStagingRefused({ reason: "budget" }));
  }
  if (input.outcome._tag === "Settled" && input.outcome.results[0]?.meta.changes === 1) {
    return Effect.succeed({ replayed: false, submissionId: input.submissionId });
  }
  return Effect.gen(function* () {
    const publication = yield* classifyUnpublished(config, input.attempt);
    if (!publication.replayed) return publication;
    return yield* replayOutcome(config, {
      publication,
      statements: input.replayStatements,
    });
  });
};

const publishStagedStatementSubmission = (
  config: StatementStagingConfig,
  input: Readonly<{
    userId: string;
    idempotencyKey: string;
    reference: StagedStatementReference;
    authority: TransactionAuthority;
    statements: ReadonlyArray<D1PreparedStatement>;
    replayStatements: ReplayStatements;
  }>
): ReturnType<StatementStagingService["publishStagedStatementSubmission"]> =>
  Effect.gen(function* () {
    const reference = Schema.decodeOption(StagedStatementReferenceSchema)(input.reference);
    if (Option.isNone(reference)) return yield* failed("malformed-file");
    const resolution = yield* resolvePublication(config, {
      idempotencyKey: input.idempotencyKey,
      reference: reference.value,
      userId: input.userId,
    });
    if (resolution._tag === "Replay") {
      return yield* replayOutcome(config, {
        publication: resolution.publication,
        statements: input.replayStatements,
      });
    }
    if (resolution._tag === "Unavailable") return yield* unavailable();
    if (resolution._tag === "Refused") return yield* resolution.failure;
    const attempt: PublicationAttempt = {
      idempotencyKey: input.idempotencyKey,
      nowEpochMs: resolution.nowEpochMs,
      stagingId: reference.value.stagingId,
      userId: input.userId,
    };
    const submissionId = newId();
    const outcome = yield* publicationUnitOutcome(config, {
      attempt,
      authority: input.authority,
      statements: input.statements,
      submissionId,
    });
    return yield* publicationOutcome(config, {
      attempt,
      outcome,
      replayStatements: input.replayStatements,
      submissionId,
    });
  });

const readOwnedStatementSubmission = (
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
  publishStagedStatementSubmission: (input) => publishStagedStatementSubmission(config, input),
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
