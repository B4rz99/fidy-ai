import { CanonicalAdmissionUnavailable } from "../../canonical-admission/contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, DateTime, Effect, Schema } from "effect";
import { Hex } from "effect/encoding";
import { UserId } from "../../../src/core/identity/contract";
import { AllowanceMeter, freeAllowanceLimits } from "../../../src/core/quotas/contract";
import { allowancePeriod, projectQuotaStatus } from "../../../src/core/quotas/operations";
import { activeProUserCondition } from "../../../src/shell/access-tier/operations";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { ConsentSubject } from "../../../src/shell/consent/contract";
import { allowanceConsumptionCount } from "../../quotas/operations";
import {
  preserveStoreAlarm,
  withStoreAdmission,
  withStoreCapacity,
} from "../../runtime/sqlite/operations";
import { newId } from "../../secret-material/operations";
import { type LocalIngestionRequest, NativeMedia } from "../contract";
import { claimIngestionCapacity, updateSharedCapacity } from "./email-capacity";
import { mediaEvidenceLifetimeMs } from "./media-retention-policy";

const isResponse = Schema.is(Schema.instanceOf(Response));

type Inbound = typeof NativeMedia.Type;

const endOfProviderSecond = 999;

const stageLifetimeMs = 60_000,
  userLimit = 50,
  pageSize = 32;

const denied = 403,
  conflict = 409,
  limited = 429,
  unavailable = 503,
  accepted = 202;

const noStore = { "cache-control": "no-store" };

const failure = (code: string, status: number): Response =>
  Response.json(
    {
      error: {
        code,
        message:
          status === unavailable
            ? "Media admission could not be confirmed. Retry the same event."
            : "Media submission could not be admitted.",
      },
      next: [],
    },
    { status, headers: code === "rate_limited" ? { ...noStore, "retry-after": "1" } : noStore }
  );

const standing = Effect.fn(function* (input: Inbound, current: number) {
  const user = UserId.make(input.userId),
    sql = yield* SqliteClient;

  const live = protectConsentStatement({
    subject: ConsentSubject.User({ userId: user }),
    requirement: "active",
    statement: {
      sql: "SELECT 1 FROM users WHERE id=? AND whatsapp_portfolio_id=? AND whatsapp_bsuid=? AND whatsapp_verified_at_ms<=? AND NOT EXISTS(SELECT 1 FROM erasure_requests)",
      params: [user, input.portfolio, input.bsuid, input.occurredAt + endOfProviderSecond],
    },
  });

  if ((yield* sql.unsafe(live.sql, live.params)).length !== 1) {
    return failure("user_action_required", denied);
  }

  const pro = activeProUserCondition({ userId: user, nowEpochMs: current }),
    used = allowanceConsumptionCount({ userId: user, allowance: "media_submission", current });

  const [raw] = yield* sql.unsafe(`SELECT ${pro.sql} AS pro,(${used.sql}) AS used`, [
    ...pro.params,
    ...used.params,
  ]);

  return yield* Schema.decodeUnknownEffect(Schema.Struct({ pro: Schema.Int, used: Schema.Int }))(
    raw
  );
});

type Standing = Exclude<Effect.Success<ReturnType<typeof standing>>, Response>;

const response = Effect.fn(function* (id: string, current: number, meter: Standing) {
  const status = projectQuotaStatus({
    accessTier: meter.pro === 1 ? "pro" : "free",
    now: DateTime.makeUnsafe(current),
    consumed: {
      forwarded_email: 0,
      canonical_call: 0,
      hosted_history_turn: 0,
      media_submission: meter.used,
    },
  });

  const allowance = yield* Schema.encodeEffect(Schema.toCodecJson(AllowanceMeter))(
    status.mediaSubmissions
  );

  return Response.json(
    {
      data: {
        submissionId: id,
        status: "needs-review",
        reason: "extraction-unavailable",
        allowance,
      },
      next: [],
    },
    { status: accepted, headers: noStore }
  );
});

const freeLimit = freeAllowanceLimits.media_submission;

const checkLimit = (current: number): Response =>
  Response.json(
    {
      error: {
        code: "quota_exhausted",
        message: "Your Free receipt/screenshot allowance is exhausted.",
        allowance: "media_submission",
        resetsAt: DateTime.formatIso(allowancePeriod(DateTime.makeUnsafe(current)).resetsAt),
      },
      next: [],
    },
    { status: limited, headers: noStore }
  );

type Publication = { input: Inbound; digest: string; current: number };

const inspect = Effect.fn(function* ({ input, digest, current }: Publication) {
  const meter = yield* standing(input, current);

  if (isResponse(meter)) return meter;
  const sql = yield* SqliteClient;

  const [published] =
    yield* sql`SELECT id,input_digest FROM media_submissions WHERE user_id=${input.userId} AND portfolio_id=${input.portfolio} AND message_id=${input.message}`;

  if (published === undefined) {
    return meter.pro === 0 && meter.used >= freeLimit ? checkLimit(current) : meter;
  }

  return published.input_digest === digest
    ? yield* response(
        yield* Schema.decodeUnknownEffect(Schema.String)(published.id),
        current,
        meter
      )
    : failure("validation_failed", conflict);
});

const hold = Effect.fn(function* (
  { input, digest, current }: Publication,
  storage: DurableObjectStorage
) {
  const sql = yield* SqliteClient;

  return yield* withStoreAdmission((admitGrowth) =>
    Effect.gen(function* () {
      const admission = yield* inspect({ input, digest, current });

      if (isResponse(admission)) return admission;

      const [slot] =
        yield* sql`SELECT id,input_digest,state FROM media_capacity_receipts WHERE user_id=${input.userId} AND portfolio=${input.portfolio} AND message=${input.message}`;

      if (slot !== undefined) {
        if (slot.input_digest !== digest) return failure("validation_failed", conflict);

        return slot.state === "storing"
          ? yield* Schema.decodeUnknownEffect(Schema.String)(slot.id)
          : failure("unavailable", unavailable);
      }

      const [size] =
        yield* sql`SELECT count(*) AS used FROM (SELECT id FROM media_capacity_receipts WHERE user_id=${input.userId} UNION SELECT id FROM media_submissions WHERE user_id=${input.userId} AND capacity_held=1)`;

      if ((yield* Schema.decodeUnknownEffect(Schema.Int)(size?.used)) >= userLimit) {
        return failure("rate_limited", limited);
      }

      yield* admitGrowth;

      const id = newId(),
        due = current + stageLifetimeMs;

      yield* sql`INSERT INTO media_capacity_receipts(id,user_id,portfolio,message,input_digest,accepted_at_ms,expires_at_ms,due_ms,state) VALUES(${id},${input.userId},${input.portfolio},${input.message},${digest},${current},${current + mediaEvidenceLifetimeMs},${due},'storing')`;
      yield* preserveStoreAlarm(storage, due);

      return id;
    })
  );
});

const publish = Effect.fn(function* ({ input, digest, current }: Publication, id: string) {
  const sql = yield* SqliteClient,
    meter = yield* inspect({ input, digest, current });

  if (isResponse(meter)) return meter;

  const [claimed] =
    yield* sql`UPDATE media_capacity_receipts SET state='retained',due_ms=expires_at_ms WHERE id=${id} AND user_id=${input.userId} AND input_digest=${digest} AND state='storing' AND capacity_claimed=1 AND due_ms>${current} RETURNING id`;

  if (claimed === undefined) return failure("unavailable", unavailable);
  yield* sql`INSERT INTO media_submissions(id,user_id,portfolio_id,bsuid,message_id,input_digest,media_id,caption,accepted_at_ms,expires_at_ms,service_market,locale,time_zone) SELECT r.id,u.id,r.portfolio,${input.bsuid},r.message,r.input_digest,${input.mediaId},nullif(${input.caption},''),r.accepted_at_ms,r.expires_at_ms,u.service_market,u.locale,u.time_zone FROM media_capacity_receipts r JOIN users u ON u.id=r.user_id WHERE r.id=${id}`;
  yield* sql`INSERT INTO ingestion_review_items(id,user_id,source_kind,media_submission_id,reason,created_at_ms,evidence_expires_at_ms,service_market,locale,time_zone) SELECT id,user_id,'media',id,'extraction-unavailable',accepted_at_ms,expires_at_ms,service_market,locale,time_zone FROM media_submissions WHERE id=${id}`;

  const units = meter.pro === 1 ? 0 : 1,
    period = DateTime.toEpochMillis(allowancePeriod(DateTime.makeUnsafe(current)).startsAt);

  yield* sql`INSERT INTO commercial_allowance_consumptions VALUES(${input.userId},'media_submission',${id},${period},${current},${units})`;
  yield* sql`INSERT INTO audit_entries(record_type,id,user_id,outcome,occurred_at_ms) VALUES('media_admission',${id},${input.userId},'accepted',${current})`;

  const [evidence] =
    yield* sql`SELECT 1 FROM media_submissions m JOIN ingestion_review_items r ON r.user_id=m.user_id AND r.media_submission_id=m.id JOIN commercial_allowance_consumptions c ON c.user_id=m.user_id AND c.allowance='media_submission' AND c.identity=m.id JOIN audit_entries a ON a.user_id=m.user_id AND a.record_type='media_admission' AND a.outcome='accepted' AND a.id=m.id WHERE m.id=${id} AND m.user_id=${input.userId} AND m.input_digest=${digest} AND c.units=${units}`;

  if (evidence === undefined) {
    return yield* new CanonicalAdmissionUnavailable({ cause: "media_publication" });
  }

  return yield* response(id, current, { ...meter, used: meter.used + units });
});

export const admitLocalMedia = Effect.fn(function* ({
  request,
  env,
  owns,
  storage,
}: LocalIngestionRequest) {
  const input = yield* Schema.decodeUnknownEffect(NativeMedia)(
    yield* Effect.tryPromise(() => request.json())
  );

  if (!owns(input.userId)) return failure("user_action_required", denied);

  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))([
    input.mediaId,
    input.caption,
  ]);

  const digest = Hex.encode(
    new Uint8Array(
      yield* Effect.tryPromise(() =>
        crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded))
      )
    )
  );

  const current = yield* Clock.currentTimeMillis;
  const id = yield* hold({ input, digest, current }, storage);

  if (isResponse(id)) return id;

  if (
    !(yield* claimIngestionCapacity({ directory: env.DIRECTORY, purpose: "media" }, id, storage))
  ) {
    return failure("rate_limited", limited);
  }

  return yield* publish({ input, digest, current: yield* Clock.currentTimeMillis }, id).pipe(
    withStoreCapacity("growth")
  );
});

export const releaseDueMedia = Effect.fn(function* (
  directory: DurableObjectNamespace,
  current: number,
  erasing?: UserId
) {
  const sql = yield* SqliteClient;
  const filter = erasing === undefined ? sql`due_ms<=${current}` : sql`user_id=${erasing}`;

  const work = yield* withStoreCapacity("required")(
    sql`UPDATE media_capacity_receipts SET state='discarding' WHERE id IN(SELECT id FROM media_capacity_receipts WHERE ${filter} ORDER BY due_ms LIMIT ${pageSize}) RETURNING id`
  );

  yield* Effect.forEach(
    work,
    Effect.fnUntraced(function* (row) {
      const id = yield* Schema.decodeUnknownEffect(Schema.String)(row.id);
      yield* updateSharedCapacity({ directory, purpose: "media" }, id, "Release");
      yield* sql`DELETE FROM media_capacity_receipts WHERE id=${id} AND state='discarding'`;
    }),
    { discard: true }
  );
});
