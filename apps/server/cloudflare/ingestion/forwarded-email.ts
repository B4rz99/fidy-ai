import { Clock, Crypto, Data, Effect, Option, PlatformError, Result, Schema, Stream } from "effect";
import PostalMime from "postal-mime";
import {
  maximumEmailAddressCharacters,
  maximumEmailHtmlCharacters,
  maximumEmailSubjectCharacters,
  maximumEmailTextCharacters,
} from "../../src/core/ingestion/email-policy";
import { UserId } from "../../src/core/identity/reference";

/** Only a Cloudflare Email Routing event may supply this envelope; no HTTP path accepts it. */
export type ForwardedEmailMessage = Pick<
  ForwardableEmailMessage,
  "from" | "to" | "raw" | "rawSize" | "setReject"
>;
/** Private Email Worker bindings, never accessible through ingress. */
export type ForwardedEmailEnvironment = Readonly<{
  DB: D1Database;
  EMAIL_BUCKET: Readonly<{
    put: (
      key: string,
      bytes: Uint8Array,
      options: { customMetadata: { purpose: string } }
    ) => Promise<unknown>;
    delete: (key: string) => Promise<unknown>;
  }>;
  EMAIL_QUEUE: Readonly<{
    send: (job: Readonly<{ receiptId: string; userId: string }>) => Promise<unknown>;
  }>;
}>;

const maximumRawBytes = 1_048_576;
const millisecondsPerDay = 86_400_000;
const retentionDays = 90;
const retentionMs = retentionDays * millisecondsPerDay;
const maximumOutstandingUser = 100;
const maximumOutstandingGlobal = 1000;
const maximumRetainedUser = 1000;
const maximumRetainedGlobal = 10000;
const recipientPattern = /^[a-z0-9_-]{24,64}@fidyapp\.com$/u;
const maximumSweep = 25;
const dispatchCooldownMs = 60_000;
const maximumHeadersSize = 16_384;
const maximumMimeDepth = 8;
const maximumNestedMessageDepth = 0;
const hexBase = 16;

const uuid = Schema.String.check(Schema.isUUID());
const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const maximumTimeZoneCharacters = 128;
const ApprovedRecipient = Schema.Struct({
  user_id: UserId,
  time_zone: Schema.String.check(Schema.isLengthBetween(1, maximumTimeZoneCharacters)),
});
const Capacity = Schema.Struct({
  global_count: count,
  user_count: count,
  retained_user_count: count,
  retained_global_count: count,
});
const Receipt = Schema.Struct({
  id: uuid,
  state: Schema.Literals(["storing", "queued", "expired"]),
});
const ReceiptState = Schema.Struct({ state: Receipt.fields.state });
const PendingJob = Schema.Struct({ receipt_id: uuid, user_id: UserId });
const ExpiredReceipt = Schema.Struct({
  id: uuid,
  user_id: UserId,
  object_key: Schema.String.check(Schema.isPattern(/^email\/v1\/[a-f0-9-]{36}$/u)),
  state: Schema.Literals(["storing", "queued"]),
});

class EmailUnavailable extends Data.TaggedError("EmailUnavailable")<{
  readonly reason: "authority" | "size";
}> {}

const authorityUnavailable = (): EmailUnavailable => new EmailUnavailable({ reason: "authority" });
const io = <A>(tryWork: () => Promise<A>): Effect.Effect<A, EmailUnavailable> =>
  Effect.tryPromise({ try: tryWork, catch: authorityUnavailable });

/** Worker-native entropy and digest, supplied at the Email Worker boundary. */
export const emailCrypto = Crypto.make({
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
          module: "EmailCrypto",
          method: "digest",
          cause,
        }),
    }),
});
const reject = (message: ForwardedEmailMessage): void => {
  message.setReject("Mailbox unavailable");
};

const readBounded = Effect.fn(function* (raw: ReadableStream) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  yield* Stream.fromReadableStream<Uint8Array, Error>({
    evaluate: () => raw,
    onError: authorityUnavailable,
  }).pipe(
    Stream.runForEachWhile((chunk) =>
      Effect.sync(() => {
        size += chunk.byteLength;
        if (size > maximumRawBytes) return false;
        chunks.push(chunk);
        return true;
      })
    )
  );
  if (size > maximumRawBytes) return yield* new EmailUnavailable({ reason: "size" });
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
});

/**
 * Admit one Cloudflare-routed delivery. Policy rejections are final without retained bytes;
 * authority failures escape for an SMTP retry. A unique receipt precedes R2 and outbox publication.
 */
export const receiveForwardedEmail = Effect.fn(function* (
  message: ForwardedEmailMessage,
  environment: ForwardedEmailEnvironment
) {
  const now = yield* Clock.currentTimeMillis;
  if (
    !recipientPattern.test(message.to) ||
    !Number.isSafeInteger(message.rawSize) ||
    message.rawSize < 1 ||
    message.rawSize > maximumRawBytes ||
    message.from.length > maximumEmailAddressCharacters
  ) {
    reject(message);
    return;
  }
  const localPart = message.to.slice(0, message.to.indexOf("@"));
  const candidate = yield* io(() =>
    environment.DB.prepare(
      `SELECT a.user_id, u.time_zone FROM email_forwarding_addresses a
     JOIN users u ON u.id = a.user_id
     JOIN onboarding_consent_records c ON c.user_id = a.user_id
     WHERE a.local_part = ? AND NOT EXISTS (
       SELECT 1 FROM consent_user_revocations r WHERE r.user_id = a.user_id)`
    )
      .bind(localPart)
      .first()
  );
  if (candidate === null) {
    reject(message);
    return;
  }
  const decoded = Schema.decodeUnknownOption(ApprovedRecipient)(candidate);
  if (Option.isNone(decoded)) return yield* authorityUnavailable();
  const approved = decoded.value;
  // Advisory cheap preflight: the D1 trigger enforces both capacities atomically at reservation.
  const capacity = yield* io(() =>
    environment.DB.prepare(
      `SELECT
      (SELECT count(*) FROM forwarded_email_receipts r WHERE state IN ('storing','queued')
       AND expires_at_ms > ? AND NOT EXISTS (SELECT 1 FROM forwarded_email_outcomes o WHERE o.receipt_id = r.id)) AS global_count,
      (SELECT count(*) FROM forwarded_email_receipts r WHERE state IN ('storing','queued')
       AND user_id = ? AND expires_at_ms > ? AND NOT EXISTS (SELECT 1 FROM forwarded_email_outcomes o WHERE o.receipt_id = r.id)) AS user_count,
      (SELECT count(*) FROM forwarded_email_receipts r WHERE r.user_id = ? AND r.received_at_ms > ?) AS retained_user_count,
      (SELECT count(*) FROM forwarded_email_receipts r WHERE r.received_at_ms > ?) AS retained_global_count`
    )
      .bind(now, approved.user_id, now, approved.user_id, now - retentionMs, now - retentionMs)
      .first()
  );
  const available = Schema.decodeUnknownOption(Capacity)(capacity);
  if (Option.isNone(available)) return yield* authorityUnavailable();
  if (
    available.value.global_count >= maximumOutstandingGlobal ||
    available.value.user_count >= maximumOutstandingUser ||
    available.value.retained_user_count >= maximumRetainedUser ||
    available.value.retained_global_count >= maximumRetainedGlobal
  ) {
    reject(message);
    return;
  }
  const collected = yield* Effect.result(readBounded(message.raw));
  if (Result.isFailure(collected)) {
    if (collected.failure instanceof EmailUnavailable && collected.failure.reason === "size") {
      reject(message);
      return;
    }
    return yield* authorityUnavailable();
  }
  const bytes = collected.success;
  if (bytes.byteLength !== message.rawSize) {
    reject(message);
    return;
  }
  const parsed = yield* Effect.exit(
    io(() =>
      PostalMime.parse(bytes, {
        maxHeadersSize: maximumHeadersSize,
        maxNestingDepth: maximumMimeDepth,
        maxRfc822NestingDepth: maximumNestedMessageDepth,
      })
    )
  );
  if (parsed._tag === "Failure") {
    reject(message);
    return;
  }
  const mime = parsed.value;
  // Even inline images and nested message parts are refused, not expanded or treated as trusted.
  if (
    mime.attachments.length !== 0 ||
    (mime.text?.length ?? 0) > maximumEmailTextCharacters ||
    (mime.html?.length ?? 0) > maximumEmailHtmlCharacters ||
    (mime.subject?.length ?? 0) > maximumEmailSubjectCharacters ||
    (mime.text === undefined && mime.html === undefined)
  ) {
    reject(message);
    return;
  }
  const digestBytes = yield* io(() => crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  const digest = Array.from(new Uint8Array(digestBytes), (byte) =>
    byte.toString(hexBase).padStart(2, "0")
  ).join("");
  const previous = yield* io(() =>
    environment.DB.prepare(
      "SELECT id, state FROM forwarded_email_receipts WHERE user_id = ? AND delivery_digest = ?"
    )
      .bind(approved.user_id, digest)
      .first()
  );
  if (previous !== null) {
    const receipt = Schema.decodeUnknownOption(Receipt)(previous);
    if (Option.isNone(receipt)) return yield* authorityUnavailable();
    if (receipt.value.state === "queued" || receipt.value.state === "expired") return;
    return yield* authorityUnavailable();
  }
  const cryptoService = yield* Crypto.Crypto;
  const id = yield* cryptoService.randomUUIDv4;
  const objectKey = `email/v1/${yield* cryptoService.randomUUIDv4}`;
  const reservation = yield* Effect.exit(
    io(() =>
      environment.DB.prepare(
        `INSERT INTO forwarded_email_receipts
     (id, user_id, delivery_digest, object_key, byte_length, state, received_at_ms, expires_at_ms, time_zone)
     VALUES (?, ?, ?, ?, ?, 'storing', ?, ?, ?)`
      )
        .bind(
          id,
          approved.user_id,
          digest,
          objectKey,
          bytes.byteLength,
          now,
          now + retentionMs,
          approved.time_zone
        )
        .run()
    )
  );
  if (reservation._tag === "Failure") {
    const duplicate = yield* io(() =>
      environment.DB.prepare(
        "SELECT id, state FROM forwarded_email_receipts WHERE user_id = ? AND delivery_digest = ?"
      )
        .bind(approved.user_id, digest)
        .first()
    );
    const claimed = Schema.decodeUnknownOption(Receipt)(duplicate);
    if (Option.isSome(claimed) && claimed.value.state === "queued") return;
    return yield* authorityUnavailable();
  }
  // Interrupted writes stay 'storing' and retain their key until the retention deadline.
  // Deleting an in-flight reservation early could race a late R2 put and orphan private bytes.
  const stored = yield* Effect.result(
    io(() =>
      environment.EMAIL_BUCKET.put(objectKey, bytes, {
        customMetadata: { purpose: "forwarded-email" },
      })
    )
  );
  if (Result.isFailure(stored)) {
    // R2 failure is ambiguous: delete first, then release capacity only if cleanup succeeded.
    yield* io(() => environment.EMAIL_BUCKET.delete(objectKey));
    yield* io(() =>
      environment.DB.prepare(
        "DELETE FROM forwarded_email_receipts WHERE id = ? AND user_id = ? AND state = 'storing'"
      )
        .bind(id, approved.user_id)
        .run()
    );
    return yield* authorityUnavailable();
  }
  const publication = yield* Effect.result(
    io(() =>
      environment.DB.batch([
        environment.DB.prepare(
          "UPDATE forwarded_email_receipts SET state = 'queued' WHERE id = ? AND user_id = ? AND state = 'storing'"
        ).bind(id, approved.user_id),
        environment.DB.prepare(
          `INSERT INTO forwarded_email_outbox (receipt_id, user_id)
       SELECT id, user_id FROM forwarded_email_receipts WHERE id = ? AND user_id = ? AND state = 'queued'`
        ).bind(id, approved.user_id),
      ])
    )
  );
  if (Result.isSuccess(publication) && publication.success[1]?.meta.changes === 1) return;
  // A failed batch is ambiguous (the response can be lost after commit). Never delete a
  // successfully queued object; otherwise remove both private bytes and its reservation.
  const committed = yield* io(() =>
    environment.DB.prepare(
      "SELECT state FROM forwarded_email_receipts WHERE id = ? AND user_id = ?"
    )
      .bind(id, approved.user_id)
      .first()
  );
  const published = Schema.decodeUnknownOption(ReceiptState)(committed);
  if (Option.isSome(published) && published.value.state === "queued") return;
  yield* io(() => environment.EMAIL_BUCKET.delete(objectKey));
  yield* io(() =>
    environment.DB.prepare(
      "DELETE FROM forwarded_email_receipts WHERE id = ? AND user_id = ? AND state = 'storing'"
    )
      .bind(id, approved.user_id)
      .run()
  );
  return yield* authorityUnavailable();
});

/** Publish only an opaque receipt identity and its explicit UserId; redelivery is expected. */
export const dispatchForwardedEmail = Effect.fn(function* (environment: ForwardedEmailEnvironment) {
  const now = yield* Clock.currentTimeMillis;
  const rows = yield* io(() =>
    environment.DB.prepare(
      `SELECT o.receipt_id, o.user_id FROM forwarded_email_outbox o
     JOIN forwarded_email_receipts r ON r.id = o.receipt_id AND r.user_id = o.user_id
     WHERE (o.sent_at_ms IS NULL OR o.sent_at_ms < ?)
       AND r.state = 'queued' AND r.expires_at_ms > ?
       AND NOT EXISTS (SELECT 1 FROM forwarded_email_outcomes f WHERE f.receipt_id = r.id)
       AND EXISTS (SELECT 1 FROM onboarding_consent_records c WHERE c.user_id = o.user_id)
       AND NOT EXISTS (SELECT 1 FROM consent_user_revocations c WHERE c.user_id = o.user_id)
     LIMIT 25`
    )
      .bind(now - dispatchCooldownMs, now)
      .all()
  );
  const jobs = Schema.decodeUnknownOption(Schema.Array(PendingJob))(rows.results);
  if (Option.isNone(jobs)) return yield* authorityUnavailable();
  for (const row of jobs.value) {
    const claimed = yield* io(() =>
      environment.DB.prepare(
        `UPDATE forwarded_email_outbox SET sent_at_ms = ? WHERE receipt_id = ? AND user_id = ?
       AND (sent_at_ms IS NULL OR sent_at_ms < ?)`
      )
        .bind(now, row.receipt_id, row.user_id, now - dispatchCooldownMs)
        .run()
    );
    if (claimed.meta.changes !== 1) continue;
    yield* io(() =>
      environment.EMAIL_QUEUE.send({ receiptId: row.receipt_id, userId: row.user_id })
    );
  }
});

/** Delete private bytes only at their hard retention deadline; keep replay tombstones. */
export const sweepForwardedEmail = Effect.fn(function* (environment: ForwardedEmailEnvironment) {
  const now = yield* Clock.currentTimeMillis;
  const rows = yield* io(() =>
    environment.DB.prepare(
      `SELECT id, user_id, object_key, state FROM forwarded_email_receipts
     WHERE state IN ('storing', 'queued') AND (expires_at_ms <= ?
       OR (state = 'queued' AND EXISTS
         (SELECT 1 FROM consent_user_revocations c WHERE c.user_id = forwarded_email_receipts.user_id)))
     LIMIT ?`
    )
      .bind(now, maximumSweep)
      .all()
  );
  const expired = Schema.decodeUnknownOption(Schema.Array(ExpiredReceipt))(rows.results);
  if (Option.isNone(expired)) return yield* authorityUnavailable();
  for (const row of expired.value) {
    {
      const reviewId = yield* emailCrypto.randomUUIDv4;
      yield* io(() =>
        environment.DB.batch([
          environment.DB.prepare(`INSERT INTO forwarded_email_needs_review
          (id, receipt_id, user_id, reason, created_at_ms, evidence_expires_at_ms)
          SELECT ?, id, user_id,
          CASE WHEN EXISTS (SELECT 1 FROM consent_user_revocations c WHERE c.user_id = r.user_id)
            THEN 'consent-revoked' ELSE 'processing-interrupted' END, ?, expires_at_ms
          FROM forwarded_email_receipts r WHERE r.id = ? AND r.user_id = ?
          AND NOT EXISTS (SELECT 1 FROM forwarded_email_outcomes o WHERE o.receipt_id = r.id)`).bind(
            reviewId,
            now,
            row.id,
            row.user_id
          ),
          environment.DB.prepare(`INSERT INTO forwarded_email_outcomes
          (receipt_id, user_id, outcome, transaction_id, review_id, completed_at_ms)
          SELECT ?, ?, 'needs-review', NULL, ?, ?
          WHERE EXISTS (SELECT 1 FROM forwarded_email_needs_review WHERE id = ?)
          AND NOT EXISTS (SELECT 1 FROM forwarded_email_outcomes WHERE receipt_id = ?)`).bind(
            row.id,
            row.user_id,
            reviewId,
            now,
            reviewId,
            row.id
          ),
        ])
      );
    }
    yield* io(() => environment.EMAIL_BUCKET.delete(row.object_key));
    yield* io(() =>
      environment.DB.prepare(
        "UPDATE forwarded_email_receipts SET state = 'expired' WHERE id = ? AND user_id = ? AND state IN ('storing', 'queued')"
      )
        .bind(row.id, row.user_id)
        .run()
    );
  }
});
