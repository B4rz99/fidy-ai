import { Clock, Effect, Schema, Struct } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import {
  DirectoryWriteUnavailable,
  IdentityOutcome,
  ReplacementInput,
  ReservedIdentity,
  emailRouteUrl,
  localIdentityCancelUrl,
  localIdentityCommitUrl,
} from "../contract";
import { EmailAddress } from "../../../src/core/email-authentication/contract";
import { UserId } from "../../../src/core/identity/contract";

type Change = typeof ReservedIdentity.Type;

const isResponse = Schema.is(Schema.instanceOf(Response));

const conflictStatus = 409;

const refusal = (): Response => new Response(null, { status: conflictStatus });

const replay = Effect.fn(function* (input: typeof ReplacementInput.Type, existing: unknown) {
  const selected = yield* Schema.decodeUnknownEffect(ReservedIdentity)(existing);
  const match = Struct.keys(ReplacementInput.fields).every((key) => selected[key] === input[key]);
  const sql = yield* SqliteClient;
  const held = yield* sql`SELECT 1 FROM erasure_barriers WHERE user_id=${selected.user_id}`;

  if (!match || held.length > 0) return refusal();

  const { state } = yield* Schema.decodeUnknownEffect(Schema.Struct({ state: Schema.Unknown }))(
    existing
  );

  if (state === "reserved") return selected;

  return state === "committed" ? new Response(null) : refusal();
});

const reserve = Effect.fn(function* (input: typeof ReplacementInput.Type) {
  const sql = yield* SqliteClient;
  const [existing] = yield* sql`SELECT * FROM identity_replacements WHERE id=${input.id}`;

  if (existing !== undefined) return yield* replay(input, existing);

  if (
    input.expires_at_ms <= (yield* Clock.currentTimeMillis) ||
    input.prior_key === input.next_key
  ) {
    return refusal();
  }

  const [source] =
    input.kind === "email"
      ? yield* sql`SELECT user_id,reservation_id AS prior_reservation,revision FROM verified_email_routes WHERE normalized_address=${input.prior_key} AND user_id=${input.expected_user}`
      : yield* sql`SELECT user_id,attempt_id AS prior_reservation,revision FROM whatsapp_routes WHERE portfolio=${input.scope} AND bsuid=${input.prior_key} AND established=1`;

  if (source === undefined) return refusal();
  const record = yield* Schema.decodeUnknownEffect(ReservedIdentity)({ ...input, ...source });

  const claimed =
    input.kind === "email"
      ? yield* sql`INSERT INTO verified_email_routes VALUES(${record.next_key},${record.user_id},${record.id},${record.revision + 1}) ON CONFLICT DO NOTHING RETURNING 1`
      : yield* sql`INSERT INTO whatsapp_routes VALUES(${record.scope},${record.next_key},${record.user_id},${record.id},1,${record.revision + 1}) ON CONFLICT DO NOTHING RETURNING 1`;

  if (claimed.length !== 1) return refusal();
  yield* sql`INSERT INTO identity_replacements(id,kind,scope,prior_key,next_key,occurred_at_ms,expires_at_ms,expected_user,user_id,revision,prior_reservation,state) VALUES(${record.id},${record.kind},${record.scope},${record.prior_key},${record.next_key},${record.occurred_at_ms},${record.expires_at_ms},${record.expected_user},${record.user_id},${record.revision},${record.prior_reservation},'reserved') RETURNING 1`.pipe(
    Effect.filterOrFail(
      (rows) => rows.length === 1,
      () => new DirectoryWriteUnavailable()
    )
  );

  return record;
});

const reconcile = Effect.fn(function* (
  record: Change,
  users: Pick<DurableObjectNamespace, "getByName">,
  cancel: boolean
) {
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(ReservedIdentity))(record);

  const answer = yield* Effect.tryPromise((signal) =>
    users
      .getByName(record.user_id)
      .fetch(cancel ? localIdentityCancelUrl : localIdentityCommitUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal,
      })
  );

  if (!answer.ok) return new Response(null, { status: 503 });

  const outcome = yield* Schema.decodeUnknownEffect(IdentityOutcome)(
    yield* Effect.tryPromise(() => answer.json())
  );

  const committed = outcome === "committed";
  const key = committed ? record.prior_key : record.next_key;
  const reservation = committed ? record.prior_reservation : record.id;
  const revision = committed ? record.revision : record.revision + 1;
  const sql = yield* SqliteClient;
  yield* Effect.gen(function* () {
    const settled =
      yield* sql`UPDATE identity_replacements SET state=${outcome} WHERE id=${record.id} AND state='reserved' RETURNING 1`;

    if (settled.length !== 1) {
      const terminal =
        yield* sql`SELECT 1 FROM identity_replacements WHERE id=${record.id} AND state=${outcome}`;

      if (terminal.length !== 1) return yield* new DirectoryWriteUnavailable();

      return;
    }

    if ((yield* sql`SELECT 1 FROM erasure_barriers WHERE user_id=${record.user_id}`).length > 0) {
      return;
    }

    const table = sql(record.kind === "email" ? "verified_email_routes" : "whatsapp_routes");

    const exact =
      record.kind === "email"
        ? sql`normalized_address=${key} AND reservation_id=${reservation}`
        : sql`portfolio=${record.scope} AND bsuid=${key} AND attempt_id=${reservation}`;

    const target = sql`user_id=${record.user_id} AND revision=${revision} AND ${exact}`;
    const removed = yield* sql`DELETE FROM ${table} WHERE ${target} RETURNING 1`;

    if (removed.length === 0) {
      const retained = yield* sql`SELECT 1 FROM ${table} WHERE ${target}`;

      if (retained.length !== 0) return yield* new DirectoryWriteUnavailable();
    }
  }).pipe(withStoreCapacity("required"));

  return committed ? new Response(null) : refusal();
});

export const findMailboxRoute = Effect.fn(function* (address: EmailAddress) {
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT user_id,revision FROM verified_email_routes WHERE normalized_address=${address}`;

  return yield* Schema.decodeUnknownEffect(
    Schema.NullOr(Schema.Struct({ user_id: UserId, revision: Schema.Int }))
  )(row ?? null);
});

export const directoryIdentityRequest = Effect.fn(function* (
  request: Request,
  users: Pick<DurableObjectNamespace, "getByName">
) {
  if (request.url === emailRouteUrl) {
    const address = yield* Schema.decodeEffect(EmailAddress)(
      yield* Effect.tryPromise(() => request.text())
    );

    const route = yield* findMailboxRoute(address);

    return route === null ? new Response(null, { status: 404 }) : Response.json(route);
  }

  const input = yield* Schema.decodeUnknownEffect(ReplacementInput)(
    yield* Effect.tryPromise(() => request.json())
  );

  const record = yield* reserve(input).pipe(withStoreCapacity("growth"));

  if (isResponse(record)) return record;

  return yield* reconcile(record, users, false);
});

const pageSize = 16;

const checkCooldownMs = 60_000;

export const reconcileIdentityReplacements = Effect.fn(function* (
  users: Pick<DurableObjectNamespace, "getByName">
) {
  const sql = yield* SqliteClient;
  const now = yield* Clock.currentTimeMillis;

  const rows =
    yield* sql`UPDATE identity_replacements SET retry_at_ms=${now + checkCooldownMs} WHERE id IN (SELECT id FROM identity_replacement_checks WHERE due_ms<=${now} ORDER BY due_ms,id LIMIT ${pageSize}) RETURNING *`;

  yield* Effect.forEach(
    rows,
    (row) =>
      Schema.decodeUnknownEffect(ReservedIdentity)(row).pipe(
        Effect.flatMap((record) => reconcile(record, users, true)),
        Effect.timeout("5 seconds"),
        Effect.result
      ),
    { concurrency: 4, discard: true }
  );
  yield* sql`DELETE FROM identity_replacements WHERE id IN(SELECT id FROM identity_replacements WHERE state<>'reserved' AND expires_at_ms<=${now} LIMIT ${pageSize})`;
});
