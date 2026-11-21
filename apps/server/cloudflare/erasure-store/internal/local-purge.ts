import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Schema } from "effect";
import { ErasureCustodian } from "../../../src/core/erasure/contract";
import { directoryName } from "../../directory/contract";
import { pricingName } from "../../subscription/contract";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import {
  ErasureHandoff,
  LocalCustody,
  ResendScopePage,
  confirmDrainUrl,
  connectionSuppressionStatus,
  localDrainUrl,
  localPurgeUrl,
  participantDrainedUrl,
  resendScopeCursor,
  resendScopePageStatus,
} from "../contract";

const acknowledged = 204,
  success = 200,
  missing = 404,
  conflict = 409;

type Target = Pick<DurableObjectNamespace, "getByName">;

type Scope = typeof ErasureHandoff.Type;

const acknowledgedBy = Effect.fn(function* (
  target: Pick<Fetcher, "fetch">,
  url: string,
  body: string
) {
  const result = yield* Effect.tryPromise((signal) =>
    target.fetch(url, { method: "POST", body, signal })
  ).pipe(Effect.timeout("5 seconds"));

  return result.status === acknowledged;
});

const sealDrain = Effect.fn(function* (record: Scope, drained: Response) {
  const sql = yield* SqliteClient;

  const usage = yield* Schema.decodeUnknownEffect(LocalCustody, { onExcessProperty: "error" })(
    yield* Effect.tryPromise(() => drained.json())
  );

  const observed = {
    Cloudflare: 1,
    Kapso: usage.whatsapp,
    Meta: usage.whatsapp,
    Resend: usage.resend,
    Wompi: usage.wompi,
  };

  yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;

      const sealed =
        yield* sql`UPDATE erasure_cases SET state='Sealing',connection_blocked=0,drained_at_ms=${now} WHERE reference=${record.reference} AND user_id=${record.userId} AND requested_at_ms=${record.requestedAtMs} AND directory_fenced=1 AND pricing_fenced=1 AND maintenance_fenced=1 AND shared_drained=1 AND state='Draining' RETURNING reference`;

      if (sealed.length === 0) return;

      yield* Effect.forEach(
        ErasureCustodian.literals,
        (custodian) =>
          sql`INSERT INTO erasure_case_custodians(reference,custodian,observed_use,status) VALUES(${record.reference},${custodian},${observed[custodian]},'Pending')`,
        { discard: true }
      );
    })
  );
});

const receiveDrain = Effect.fn(function* (record: Scope, drained: Response) {
  const sql = yield* SqliteClient;
  const exact = sql`reference=${record.reference} AND user_id=${record.userId} AND requested_at_ms=${record.requestedAtMs} AND directory_fenced=1 AND pricing_fenced=1 AND maintenance_fenced=1`;

  if (drained.status === resendScopePageStatus) {
    const page = yield* Schema.decodeUnknownEffect(ResendScopePage, {
      onExcessProperty: "error",
    })(yield* Effect.tryPromise(() => drained.json()));

    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(ResendScopePage))(page);
    yield* withStoreCapacity(
      "required"
    )(sql`INSERT INTO erasure_resend_scope(reference,work_id,requested_at_ms)
        SELECT reference,json_extract(value,'$.work_id'),json_extract(value,'$.requested_at_ms') FROM erasure_cases,json_each(${encoded}) WHERE ${exact} AND state='Draining' AND shared_drained=1 ON CONFLICT(reference,work_id) DO NOTHING`);

    return;
  }

  if (drained.status === connectionSuppressionStatus) {
    yield* sql`UPDATE erasure_cases SET connection_blocked=1 WHERE ${exact} AND state='Draining'`;

    return;
  }

  if (drained.status !== success) return;
  yield* sealDrain(record, drained);
});

export const advanceLocalPurge = Effect.fn(function* (
  record: Scope & { state: string },
  env: Readonly<Record<"USER_STORE" | "DIRECTORY" | "PRICING", Target>>
) {
  const sql = yield* SqliteClient;
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(ErasureHandoff))(record);
  const exact = sql`reference=${record.reference} AND user_id=${record.userId} AND requested_at_ms=${record.requestedAtMs} AND directory_fenced=1 AND pricing_fenced=1 AND maintenance_fenced=1`;

  if (record.state === "Draining") {
    const shared = yield* Effect.all(
      [
        acknowledgedBy(env.DIRECTORY.getByName(directoryName), participantDrainedUrl, body),
        acknowledgedBy(env.PRICING.getByName(pricingName), participantDrainedUrl, body),
      ],
      { concurrency: 2 }
    );

    if (shared.includes(false)) return;
    yield* sql`UPDATE erasure_cases SET shared_drained=1 WHERE ${exact} AND state='Draining' AND shared_drained=0`;

    const drained = yield* Effect.tryPromise((signal) =>
      env.USER_STORE.getByName(record.userId).fetch(localDrainUrl, { method: "POST", body, signal })
    ).pipe(Effect.timeout("5 seconds"));

    yield* receiveDrain(record, drained);
  } else if (record.state === "Sealing") {
    yield* sql`UPDATE erasure_cases SET state='Erasing' WHERE ${exact} AND state='Sealing' AND drained_at_ms IS NOT NULL AND (SELECT count(*) FROM erasure_case_custodians WHERE reference=${record.reference})=${ErasureCustodian.literals.length}`;
  } else if (record.state === "Erasing") {
    if (!(yield* acknowledgedBy(env.USER_STORE.getByName(record.userId), localPurgeUrl, body))) {
      return;
    }

    const now = yield* Clock.currentTimeMillis;
    yield* sql`UPDATE erasure_cases SET state='ExternalPending',last_erased_at_ms=${now} WHERE ${exact} AND state='Erasing'`;
  }
});

export const emptyUserDisposition = Effect.fn(function* (request: Request) {
  const user = yield* Schema.decodeUnknownEffect(ErasureHandoff.fields.userId)(
    yield* Effect.tryPromise(() => request.json())
  );

  const sql = yield* SqliteClient;
  const row = yield* sql`SELECT 1 FROM erasure_cases WHERE user_id=${user}`;

  return new Response(null, { status: row.length === 1 ? acknowledged : missing });
});

export const confirmPurge = Effect.fn(function* (request: Request) {
  const scope = yield* Schema.decodeUnknownEffect(ErasureHandoff, { onExcessProperty: "error" })(
    yield* Effect.tryPromise(() => request.json())
  );

  const sql = yield* SqliteClient;

  const phase =
    request.url === confirmDrainUrl
      ? sql`state='Draining'`
      : sql`state='Erasing' AND drained_at_ms IS NOT NULL`;

  const rows =
    yield* sql`SELECT coalesce((SELECT max(work_id) FROM erasure_resend_scope WHERE reference=${scope.reference}), '') AS mail_cursor FROM erasure_cases WHERE user_id=${scope.userId} AND reference=${scope.reference} AND requested_at_ms=${scope.requestedAtMs} AND ${phase} AND shared_drained=1 AND directory_fenced=1 AND pricing_fenced=1 AND maintenance_fenced=1`;

  const [row] = rows;

  if (row === undefined) return new Response(null, { status: conflict });

  return new Response(null, {
    status: acknowledged,
    headers: {
      [resendScopeCursor]: yield* Schema.decodeUnknownEffect(Schema.String)(row.mail_cursor),
    },
  });
});
