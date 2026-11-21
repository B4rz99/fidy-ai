import type { LocalIngestionRequest } from "../contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, DateTime, Effect, Option, Predicate, Schema } from "effect";
import { Hex } from "effect/encoding";
import PostalMime from "postal-mime";
import {
  EmailForwardingLocalPart,
  freeForwardedEmailCap,
  freeForwardedEmailDeferredCap,
  maximumEmailAddressCharacters,
  maximumEmailHtmlCharacters,
  maximumEmailSubjectCharacters,
  maximumEmailTextCharacters,
} from "../../../src/core/ingestion/contract";
import { UserContext, UserId } from "../../../src/core/identity/contract";
import { allowancePeriod } from "../../../src/core/quotas/operations";
import { allowanceConsumptionCount } from "../../quotas/operations";
import { activeProUserCondition } from "../../../src/shell/access-tier/operations";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { ConsentSubject } from "../../../src/shell/consent/contract";
import { lookupExternalEventRoute } from "../../directory/operations";
import {
  type ForwardedEmailMessage,
  ForwardedEmailWork,
  type LocalIngestionEnvironment,
  type NativeEmailEnvironment,
  localEmailUrl,
} from "../contract";

import { settleObservedOriginal, trackOriginalPut } from "./original-writers";
import { resumePrivateUpload, userPrivateObjectPrefix } from "../../private-objects/operations";
import { prepareSourcedCapture } from "../../transactions/operations";
import { CanonicalAdmissionUnavailable } from "../../canonical-admission/contract";
import { newId } from "../../secret-material/operations";
import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";
import {
  maximumHeadersSize,
  maximumMimeDepth,
  maximumNestedMessageDepth,
  maximumOutstandingUser,
  maximumRawBytes,
  maximumRetainedUser,
  readBounded,
  recipientPattern,
  retentionMs,
} from "./email-envelope";
import { claimIngestionCapacity, settleSharedEmailCapacity } from "./email-capacity";
import { Receipt, anonymizeStructure, decideEmail } from "./forwarded-email-processing";

export const emailStageRetryMs = 60000;

const abandonmentMs = 900000;

const noContent = 204,
  unprocessable = 422,
  notFound = 404;

const fail = (): CanonicalAdmissionUnavailable =>
  new CanonicalAdmissionUnavailable({ cause: "email_unavailable" });

const refused = (): Response => new Response(null, { status: 422 });

const nothing = (): Response => new Response(null, { status: 204 });

const mimeOptions = {
  maxHeadersSize: maximumHeadersSize,
  maxNestingDepth: maximumMimeDepth,
  maxRfc822NestingDepth: maximumNestedMessageDepth,
};

const invalidEnvelope = (message: ForwardedEmailMessage): boolean =>
  !recipientPattern.test(message.to) ||
  message.from.length > maximumEmailAddressCharacters ||
  !Number.isSafeInteger(message.rawSize) ||
  message.rawSize < 1 ||
  message.rawSize > maximumRawBytes;

export const receivePrivateEmail = Effect.fn(
  function* (message: ForwardedEmailMessage, env: NativeEmailEnvironment) {
    const reject = (): void => message.setReject("Mailbox unavailable");

    if (invalidEnvelope(message)) {
      return reject();
    }

    const lookup = EmailForwardingLocalPart.make(message.to.slice(0, message.to.indexOf("@")));

    const route = yield* lookupExternalEventRoute(env.DIRECTORY, {
      kind: "forwarding",
      endpoint: "fidyapp.com",
      lookup,
    });

    if (Option.isNone(route) || route.value.family !== "forwarding") return reject();
    const target = route.value;

    const response = yield* Effect.tryPromise((signal) =>
      env.USER_STORE.getByName(target.userId).fetch(localEmailUrl, {
        method: "POST",
        signal,
        headers: {
          "fidy-email-route": target.operationId,
          "fidy-email-size": String(message.rawSize),
          "fidy-email-recipient": lookup,
          "fidy-user-id": target.userId,
        },
        body: message.raw,
      })
    );

    if (response.status === unprocessable || response.status === notFound) return reject();

    if (response.status !== noContent) return yield* fail();
  },
  Effect.mapError((cause) => new CanonicalAdmissionUnavailable({ cause }))
);

const address = Effect.fn(function* (user: UserId, id: string, part: string) {
  const sql = yield* SqliteClient;

  const authority = protectConsentStatement({
    subject: ConsentSubject.User({ userId: user }),
    requirement: "active",
    statement: {
      sql: "SELECT u.time_zone FROM forwarding_addresses a JOIN users u ON u.id=a.user_id WHERE a.user_id=? AND a.id=? AND a.local_part=? AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=u.id)",
      params: [user, id, part],
    },
  });

  const [row] = yield* sql.unsafe(authority.sql, authority.params);

  return Schema.decodeUnknownOption(Schema.Struct({ time_zone: UserContext.fields.timeZone }))(row);
});

export const activateLocalEmail = Effect.fn(function* (user: UserId, id: string, current: number) {
  const sql = yield* SqliteClient;

  const pro = activeProUserCondition({ userId: user, nowEpochMs: current }),
    used = allowanceConsumptionCount({ userId: user, current, allowance: "forwarded_email" });

  const [raw] = yield* sql.unsafe(`SELECT ${pro.sql} AS pro,(${used.sql}) AS used`, [
    ...pro.params,
    ...used.params,
  ]);

  const stats = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ pro: Schema.Int, used: Schema.Int })
  )(raw);

  const units = stats.pro === 1 ? 0 : 1;

  if (units === 1 && stats.used >= freeForwardedEmailCap) {
    yield* sql`UPDATE forwarded_email_receipts SET state='queued',deferred_checked_at_ms=${current} WHERE user_id=${user} AND id=${id}`;

    return;
  }

  const period = DateTime.toEpochMillis(allowancePeriod(DateTime.makeUnsafe(current)).startsAt);
  yield* sql`INSERT INTO commercial_allowance_consumptions VALUES(${user},'forwarded_email',${id},${period},${current},${units}) ON CONFLICT DO NOTHING`;
  yield* sql`UPDATE forwarded_email_receipts SET state='queued',deferred_checked_at_ms=NULL WHERE user_id=${user} AND id=${id}`;
});

const fits = (text: Option.Option<string>, limit: number): boolean =>
  Option.match(text, { onNone: () => true, onSome: (value) => value.length <= limit });

const textAllowed = (mime: Awaited<ReturnType<typeof PostalMime.parse>>): boolean =>
  (mime.text !== undefined || mime.html !== undefined) &&
  fits(Option.fromUndefinedOr(mime.subject), maximumEmailSubjectCharacters) &&
  fits(Option.fromUndefinedOr(mime.text), maximumEmailTextCharacters) &&
  fits(Option.fromUndefinedOr(mime.html), maximumEmailHtmlCharacters);

const validMime = Effect.fn(function* (bytes: Uint8Array) {
  const parsed = yield* Effect.option(
    Effect.tryPromise(() => PostalMime.parse(bytes, mimeOptions))
  );

  return (
    Option.isSome(parsed) && parsed.value.attachments.length === 0 && textAllowed(parsed.value)
  );
});

const existingReceipt = Effect.fn(function* (
  prior: Readonly<Record<string, unknown>>,
  now: number
) {
  if (prior.state === "expired" || prior.state === "discarding") return refused();
  const receipt = yield* Schema.decodeUnknownEffect(Receipt)(prior);

  if (receipt.expires_at_ms <= now) return refused();

  return prior.state === "queued" ? nothing() : receipt;
});

const reserveEmail = Effect.fn(function* (
  { userId, id, part }: { userId: UserId; id: string; part: string },
  { digest, size }: { digest: string; size: number },
  storage: DurableObjectStorage
) {
  const sql = yield* SqliteClient;
  const now = yield* Clock.currentTimeMillis;
  const active = yield* address(userId, id, part);

  if (Option.isNone(active)) return refused();

  const [prior] =
    yield* sql`SELECT * FROM forwarded_email_receipts WHERE user_id=${userId} AND delivery_digest=${digest}`;

  if (prior !== undefined) {
    return yield* existingReceipt(prior, now);
  }

  const [capacity] =
    yield* sql`SELECT count(*) AS retained,count(CASE WHEN outcome IS NULL AND state!='expired' THEN 1 END) AS pending,count(deferred_checked_at_ms) AS deferred FROM forwarded_email_receipts WHERE user_id=${userId} AND expires_at_ms>${now}`;

  if (
    capacity === undefined ||
    Number(capacity.pending) >= maximumOutstandingUser ||
    Number(capacity.retained) >= maximumRetainedUser ||
    Number(capacity.deferred) >= freeForwardedEmailDeferredCap
  ) {
    return refused();
  }

  const receipt = newId(),
    key = userPrivateObjectPrefix(userId) + "email/" + newId(),
    expires = now + retentionMs;

  const [inserted] =
    yield* sql`INSERT INTO forwarded_email_receipts(id,user_id,delivery_digest,object_key,byte_length,received_at_ms,expires_at_ms,time_zone,state,stage_checked_at_ms,forwarding_address_id) VALUES(${receipt},${userId},${digest},${key},${size},${now},${expires},${active.value.time_zone},'storing',${now},${id}) RETURNING *`;

  yield* preserveStoreAlarm(storage, Math.min(expires, now + emailStageRetryMs));

  return yield* Schema.decodeUnknownEffect(Receipt)(inserted);
});

const storeEmail = Effect.fn(function* (
  {
    env,
    userId,
    id,
    part,
  }: { env: LocalIngestionEnvironment; userId: UserId; id: string; part: string },
  { bytes, digest }: { bytes: Uint8Array; digest: string },
  reserved: typeof Receipt.Type
) {
  const canWrite = Effect.gen(function* () {
    const sql = yield* SqliteClient;

    if (Option.isNone(yield* address(userId, id, part))) return false;
    const now = yield* Clock.currentTimeMillis;

    const [stored] =
      yield* sql`SELECT 1 FROM forwarded_email_receipts WHERE user_id=${userId} AND id=${reserved.id} AND state='storing' AND capacity_claimed=1 AND expires_at_ms>${now}`;

    return stored !== undefined;
  });

  const head = yield* Effect.tryPromise(() => env.EMAIL_BUCKET.head(reserved.object_key));
  yield* settleObservedOriginal("email", reserved.object_key, Option.fromNullOr(head));

  if (
    head?.customMetadata?.purpose !== "forwarded-email" ||
    head.customMetadata.sha256 !== digest
  ) {
    yield* resumePrivateUpload(
      {
        bucket: env.EMAIL_BUCKET,
        put: (key, bytes, options) =>
          trackOriginalPut(
            { bucket: env.EMAIL_BUCKET, kind: "email", user: userId },
            { key, bytes, options }
          ),
        key: reserved.object_key,
        userId,
        bytes,
        authorise: canWrite,
        digest: Option.some(Uint8Array.fromHex(digest)),
        predecessor: Option.none(),
        metadata: {
          purpose: "forwarded-email",
          sha256: digest,
          expiresAtMs: String(reserved.expires_at_ms),
        },
      },
      Option.fromNullOr(head)
    );
  }

  return { canWrite };
});

const readRequestMaterial = Effect.fn(function* (request: Request) {
  const size = Number(request.headers.get("fidy-email-size"));

  if (request.body === null || !Number.isSafeInteger(size) || size < 1 || size > maximumRawBytes) {
    return Option.none();
  }

  const bytes = yield* readBounded(request.body);

  if (bytes.length !== size || !(yield* validMime(bytes))) return Option.none();

  return Option.some(bytes);
});

export const admitLocalEmail = Effect.fn(
  function* ({ request, env, owns, storage }: LocalIngestionRequest) {
    const user = Schema.decodeUnknownOption(UserId)(request.headers.get("fidy-user-id")),
      id = request.headers.get("fidy-email-route") ?? "",
      part = request.headers.get("fidy-email-recipient") ?? "";

    if (Option.isNone(Option.filter(user, owns))) return refused();
    const userId = yield* Effect.fromOption(user, fail);
    const before = yield* address(userId, id, part);

    if (Option.isNone(before)) return refused();
    const material = yield* readRequestMaterial(request);

    if (Option.isNone(material)) return refused();
    const bytes = material.value;

    const digest = Hex.encode(
      new Uint8Array(
        yield* Effect.tryPromise(() => crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)))
      )
    );

    const reserved = yield* withStoreCapacity("growth")(
      reserveEmail({ userId, id, part }, { digest, size: bytes.length }, storage)
    );

    if (reserved instanceof Response) return reserved;

    if (
      !(yield* claimIngestionCapacity(
        { directory: env.DIRECTORY, purpose: "email" },
        reserved.id,
        storage
      ))
    ) {
      return refused();
    }

    const { canWrite } = yield* storeEmail({ env, userId, id, part }, { bytes, digest }, reserved);

    return yield* withStoreCapacity("required")(
      Effect.gen(function* () {
        const current = yield* Clock.currentTimeMillis;

        if (!(yield* canWrite)) {
          const sql = yield* SqliteClient;

          const disposition =
            yield* sql`UPDATE forwarded_email_receipts SET state='discarding' WHERE id=${reserved.id} AND user_id=${userId} AND state='storing' AND expires_at_ms>${current} RETURNING id`;

          if (disposition.length > 0) yield* preserveStoreAlarm(storage, current);

          return refused();
        }

        yield* activateLocalEmail(userId, reserved.id, current);
        yield* preserveStoreAlarm(storage, current);

        return nothing();
      })
    );
  },
  Effect.mapError((cause) => new CanonicalAdmissionUnavailable({ cause }))
);

const liveReceipt = Effect.fn(function* (user: UserId, id: string, current: number) {
  const sql = yield* SqliteClient;

  const authority = protectConsentStatement({
    subject: ConsentSubject.User({ userId: user }),
    requirement: "granted",
    statement: {
      sql: "SELECT * FROM forwarded_email_receipts WHERE id=? AND user_id=? AND expires_at_ms>? AND state='queued' AND outcome IS NULL AND deferred_checked_at_ms IS NULL AND EXISTS(SELECT 1 FROM commercial_allowance_consumptions WHERE user_id=? AND allowance='forwarded_email' AND identity=?) AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=?)",
      params: [id, user, current, user, id, user],
    },
  });

  const [raw] = yield* sql.unsafe(authority.sql, authority.params);

  return raw === undefined
    ? Option.none()
    : Option.some(yield* Schema.decodeUnknownEffect(Receipt)(raw));
});

const settleEmail = Effect.fn(function* (
  { user, receipt, current }: { user: UserId; receipt: typeof Receipt.Type; current: number },
  outcome: Effect.Success<ReturnType<typeof decideEmail>>,
  mime: Awaited<ReturnType<typeof PostalMime.parse>>
) {
  const sql = yield* SqliteClient;

  if (Predicate.isTagged(outcome, "Interpreted")) {
    const context = yield* Schema.decodeEffect(UserContext)({
      serviceMarket: "CO",
      locale: "es-CO",
      timeZone: receipt.time_zone,
    });

    const plan = yield* prepareSourcedCapture(
      { ...outcome.extraction, notes: Option.none(), categoryId: Option.none() },
      { userId: user, current },

      {
        kind: "notification-email",
        context,
        revision: outcome.evidence.revision,
        receiptId: receipt.id,
        sha256: receipt.delivery_digest,
        format: "notification-email",
        interpretation: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          outcome.evidence
        ),
      }
    );

    if (!("commit" in plan)) return yield* fail();
    const response = yield* plan.commit;

    const { data } = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ data: Schema.Struct({ id: Schema.String }) })
    )(response.body);

    yield* sql`UPDATE forwarded_email_receipts SET outcome='accepted',outcome_transaction_id=${data.id} WHERE id=${receipt.id}`;

    if (mime.html !== undefined) {
      yield* sql`INSERT INTO ingest_sample_candidates(id,user_id,receipt_id,source_format,source_provider,parser_revision,anonymization_revision,structure,expires_at_ms,service_market) VALUES(${newId()},${user},${receipt.id},'notification-email','cloudflare-email','cloudflare-mime-v1','structural-tags-v1',${anonymizeStructure(mime.html)},${receipt.expires_at_ms},'CO')`;
    }
  } else {
    const review = newId();
    yield* sql`INSERT INTO ingestion_review_items(id,user_id,source_kind,email_receipt_id,reason,created_at_ms,evidence_expires_at_ms,service_market,locale,time_zone) VALUES(${review},${user},'email',${receipt.id},${outcome.reason},${current},${receipt.expires_at_ms},'CO','es-CO',${receipt.time_zone})`;
    yield* sql`UPDATE forwarded_email_receipts SET outcome='needs-review',outcome_review_id=${review} WHERE id=${receipt.id}`;
  }
});

const matchesEmailObject = (object: R2ObjectBody, receipt: typeof Receipt.Type): boolean =>
  object.size === receipt.byte_length &&
  object.checksums.sha256 !== undefined &&
  Hex.encode(new Uint8Array(object.checksums.sha256)) === receipt.delivery_digest;

export const processLocalEmail = Effect.fn(function* (
  request: Request,
  env: LocalIngestionEnvironment,
  owns: (user: string) => boolean
) {
  const work = yield* Schema.decodeUnknownEffect(ForwardedEmailWork)(
    yield* Effect.tryPromise(() => request.json())
  );

  if (!owns(work.userId)) return new Response(null, { status: 404 });
  const user = UserId.make(work.userId);
  const live = yield* liveReceipt(user, work.receiptId, yield* Clock.currentTimeMillis);

  if (Option.isNone(live)) return nothing();
  const receipt = live.value;

  if (!receipt.object_key.startsWith(userPrivateObjectPrefix(user) + "email/")) {
    return yield* fail();
  }

  const object = yield* Effect.tryPromise(() => env.EMAIL_BUCKET.get(receipt.object_key));

  if (object === null || !matchesEmailObject(object, receipt)) return yield* fail();

  const mime = yield* Effect.tryPromise(() =>
    object.arrayBuffer().then((bytes) => PostalMime.parse(bytes, mimeOptions))
  );

  const outcome = yield* decideEmail({ parsed: mime, receipt });

  const committed = yield* withStoreCapacity("growth")(
    Effect.gen(function* () {
      const current = yield* Clock.currentTimeMillis;
      const exact = yield* liveReceipt(user, work.receiptId, current);

      if (
        Option.isNone(exact) ||
        exact.value.object_key !== receipt.object_key ||
        exact.value.delivery_digest !== receipt.delivery_digest ||
        exact.value.expires_at_ms !== receipt.expires_at_ms
      ) {
        return false;
      }

      yield* settleEmail({ user, receipt, current }, outcome, mime);

      return true;
    })
  );

  if (committed) yield* settleSharedEmailCapacity(env.DIRECTORY, receipt.id);

  return nothing();
});

const activeForwardingRoute = Effect.fn(function* (
  user: UserId,
  row: Readonly<Record<string, unknown>>
) {
  if (typeof row.id !== "string" || typeof row.local_part !== "string") return false;

  return Option.isSome(yield* address(user, row.id, row.local_part));
});

export const recoverEmailStages = Effect.fn(function* (
  current: number,
  env: LocalIngestionEnvironment
) {
  const sql = yield* SqliteClient;

  const rows = yield* withStoreCapacity("required")(
    sql`UPDATE forwarded_email_receipts SET stage_checked_at_ms=${current} WHERE id IN(SELECT id FROM forwarded_email_receipts WHERE state='storing' AND stage_checked_at_ms<=${current - emailStageRetryMs} AND expires_at_ms>${current} ORDER BY stage_checked_at_ms LIMIT 8) RETURNING *`
  );

  yield* Effect.forEach(
    rows,
    Effect.fnUntraced(function* (raw) {
      const receipt = yield* Schema.decodeUnknownEffect(Receipt)(raw),
        user = yield* Schema.decodeUnknownEffect(UserId)(raw.user_id);

      if (!receipt.object_key.startsWith(userPrivateObjectPrefix(user) + "email/")) {
        return yield* fail();
      }

      const head = yield* Effect.tryPromise(() => env.EMAIL_BUCKET.head(receipt.object_key));
      yield* settleObservedOriginal("email", receipt.object_key, Option.fromNullOr(head));

      const stored =
        head?.size === receipt.byte_length &&
        head.customMetadata?.purpose === "forwarded-email" &&
        head.checksums.sha256 !== undefined &&
        Hex.encode(new Uint8Array(head.checksums.sha256)) === receipt.delivery_digest;

      yield* withStoreCapacity("required")(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;

          const [active] =
            yield* sql`SELECT a.id,a.local_part FROM forwarded_email_receipts r LEFT JOIN forwarding_addresses a ON r.forwarding_address_id=a.id AND r.user_id=a.user_id WHERE r.user_id=${user} AND r.id=${receipt.id} AND r.state='storing' AND r.expires_at_ms>${now}`;

          if (active === undefined) return;

          if (!(yield* activeForwardingRoute(user, active))) {
            yield* sql`UPDATE forwarded_email_receipts SET state='discarding' WHERE user_id=${user} AND id=${receipt.id}`;

            return;
          }

          if (raw.capacity_claimed !== 1) {
            if (now >= receipt.received_at_ms + abandonmentMs) {
              yield* sql`UPDATE forwarded_email_receipts SET state='discarding' WHERE id=${receipt.id} AND state='storing' AND capacity_claimed=0`;
            }

            return;
          }

          if (stored) {
            yield* activateLocalEmail(user, receipt.id, now);

            return;
          }

          if (now < receipt.received_at_ms + abandonmentMs) return;
          const review = newId();
          yield* sql`INSERT INTO ingestion_review_items(id,user_id,source_kind,email_receipt_id,reason,created_at_ms,evidence_expires_at_ms,service_market,locale,time_zone) VALUES(${review},${user},'email',${receipt.id},'processing-interrupted',${now},${receipt.expires_at_ms},'CO','es-CO',${receipt.time_zone})`;
          yield* sql`UPDATE forwarded_email_receipts SET state='queued',outcome='needs-review',outcome_review_id=${review} WHERE user_id=${user} AND id=${receipt.id}`;
        })
      );
    }),
    { discard: true }
  );

  return rows.length;
});
