import {
  type StagedStatementBytes,
  type StagedStatementReference,
  StagedStatementReference as StagedStatementReferenceSchema,
  StatementContentDigest,
  type StatementStagingFailureReason,
  StatementStagingId,
  maximumStatementBytes,
  maximumStatementStagingSweep,
  statementStagingLifetimeMilliseconds,
} from "@fidy/server/statement-staging";
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
import {
  type BoundedBodyReadFailed,
  collectBoundedRequestBody,
} from "../http/bounded-request-body";

/** Versioned prefix for every statement object written by staging. */
const statementStagingObjectPrefix = "staging/statement/v1/";
const statementStagingObjectEntropyBytes = 32;

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
   * object. A replay of the same idempotency key returns the original submission; the same key
   * pointing at different material is a conflict.
   */
  readonly publishStagedStatementSubmission: (input: {
    readonly userId: string;
    readonly idempotencyKey: string;
    readonly reference: StagedStatementReference;
  }) => Effect.Effect<
    PublishedStatementSubmission,
    StatementStagingFailed | StatementStagingUnavailable
  >;
  /** Deletes at most one bounded page of expired unpublished staging rows and their R2 objects. */
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
  status: Schema.Literals(["pending", "available", "published", "deleting"]),
  expires_at_ms: Schema.Int,
});
type StagingRow = typeof StagingRow.Type;

const SubmissionRow = Schema.Struct({ id: Schema.String, staging_id: Schema.String });
type SubmissionRow = typeof SubmissionRow.Type;

const ExpiredRow = Schema.Struct({ id: Schema.String, object_key: Schema.String });

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
        `SELECT id, object_key, byte_length, sha256, status, expires_at_ms
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

const removePendingStagingRow = (database: D1Database, stagingId: string): Effect.Effect<void> =>
  settleStatement(
    database
      .prepare("DELETE FROM statement_staging_objects WHERE id = ? AND status = 'pending'")
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

const removeObject = (bucket: R2Bucket, objectKey: string): Effect.Effect<void> =>
  platformUnavailable(() => bucket.delete(objectKey)).pipe(Effect.ignore);

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
    createdAtEpochMs: number;
    expiresAtEpochMs: number;
  }>
): Effect.Effect<boolean, StatementStagingUnavailable> =>
  settleStatement(
    config.database
      .prepare(
        `INSERT INTO statement_staging_objects (
           id, user_id, object_key, byte_length, sha256, status, created_at_ms, expires_at_ms
         ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .bind(
        input.stagingId,
        input.userId,
        input.objectKey,
        input.byteLength,
        input.sha256,
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

const discardStagedUpload = (
  config: StatementStagingConfig,
  input: Readonly<{ stagingId: string; objectKey: string }>
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* removePendingStagingRow(config.database, input.stagingId);
    yield* removeObject(config.bucket, input.objectKey);
  });

const stageStatementBytes = (
  config: StatementStagingConfig,
  input: Readonly<{ userId: string; request: Request }>
): ReturnType<StatementStagingService["stageStatementBytes"]> =>
  Effect.gen(function* () {
    const bytes = yield* readBoundedStatementBytes(input.request);
    if (bytes.byteLength === 0) return yield* failed("malformed-file");
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

const publicationStatements = (
  config: StatementStagingConfig,
  input: Readonly<{
    userId: string;
    idempotencyKey: string;
    stagingId: string;
    submissionId: string;
    auditId: string;
    nowEpochMs: number;
  }>
): ReadonlyArray<D1PreparedStatement> => {
  const { database } = config;
  const { userId, idempotencyKey, stagingId, submissionId, auditId, nowEpochMs } = input;
  return [
    database
      .prepare(
        `INSERT INTO statement_submissions (id, user_id, idempotency_key, staging_id, submitted_at_ms)
         SELECT ?, ?, ?, ?, ?
         FROM statement_staging_objects
         WHERE id = ? AND user_id = ? AND status = 'available' AND expires_at_ms > ?
           AND NOT EXISTS (
             SELECT 1 FROM statement_submissions
             WHERE user_id = ? AND idempotency_key = ?
           )`
      )
      .bind(
        submissionId,
        userId,
        idempotencyKey,
        stagingId,
        nowEpochMs,
        stagingId,
        userId,
        nowEpochMs,
        userId,
        idempotencyKey
      ),
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
        `INSERT INTO statement_submission_audit (id, user_id, operation, outcome, occurred_at_ms)
         SELECT ?, user_id, 'ingestion.submitForExtraction', 'success', ?
         FROM statement_submissions
         WHERE user_id = ? AND id = ? AND changes() = 1`
      )
      .bind(auditId, nowEpochMs, userId, submissionId),
  ];
};

type PublicationPrecondition =
  | Readonly<{ _tag: "Publish"; row: StagingRow }>
  | Readonly<{ _tag: "Replay"; publication: PublishedStatementSubmission }>
  | Readonly<{ _tag: "Refused"; failure: StatementStagingFailed }>;

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
  return Option.none();
};

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
      return existing.value.staging_id === row.value.id
        ? {
            _tag: "Replay",
            publication: { replayed: true, submissionId: existing.value.id },
          }
        : { _tag: "Refused", failure: failed("conflict") };
    }
    const refusal = classifyStagedRow(row.value, input.nowEpochMs);
    return Option.isSome(refusal)
      ? { _tag: "Refused", failure: failed(refusal.value) }
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
    return yield* failed("conflict");
  });

const publishStagedStatementSubmission = (
  config: StatementStagingConfig,
  input: Readonly<{
    userId: string;
    idempotencyKey: string;
    reference: StagedStatementReference;
  }>
): ReturnType<StatementStagingService["publishStagedStatementSubmission"]> =>
  Effect.gen(function* () {
    const reference = Schema.decodeOption(StagedStatementReferenceSchema)(input.reference);
    if (Option.isNone(reference)) return yield* failed("malformed-file");
    const nowEpochMs = config.nowEpochMs();
    const precondition = yield* readPublicationPrecondition(config, {
      idempotencyKey: input.idempotencyKey,
      nowEpochMs,
      reference: reference.value,
      userId: input.userId,
    });
    if (precondition._tag === "Replay") return precondition.publication;
    if (precondition._tag === "Refused") return yield* precondition.failure;
    const refusal = yield* headStagedObject(config, precondition.row);
    if (Option.isSome(refusal)) return yield* refusal.value;
    const submissionId = newId();
    const results = yield* settleBatch(
      config.database,
      publicationStatements(config, {
        auditId: newId(),
        idempotencyKey: input.idempotencyKey,
        nowEpochMs,
        stagingId: reference.value.stagingId,
        submissionId,
        userId: input.userId,
      })
    );
    return results[0]?.meta.changes === 1
      ? { replayed: false, submissionId }
      : yield* classifyUnpublished(config, {
          idempotencyKey: input.idempotencyKey,
          nowEpochMs,
          stagingId: reference.value.stagingId,
          userId: input.userId,
        });
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
             WHERE status != 'published' AND expires_at_ms <= ?
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
    const deleted = yield* settleStatement(
      config.database
        .prepare(
          `DELETE FROM statement_staging_objects
           WHERE id IN (${rows.map(() => "?").join(", ")}) AND status = 'deleting'`
        )
        .bind(...rows.map(({ id }) => id))
    );
    return { objectsDeleted: rows.length, rowsDeleted: deleted.meta.changes };
  });

const makeStatementStagingService = (config: StatementStagingConfig): StatementStagingService => ({
  publishStagedStatementSubmission: (input) => publishStagedStatementSubmission(config, input),
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
