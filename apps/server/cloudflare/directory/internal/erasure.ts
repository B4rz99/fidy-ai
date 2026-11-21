import {
  CustodyScopeAdmission,
  type ErasureRegistryNamespace,
  custodyScopePage,
  erasureRegistryName,
} from "../../erasure/contract";
import type { CleanupCommand, CleanupPermission } from "../../erasure-store/contract";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Option, Schema } from "effect";
import { cancelProviderHandoff } from "./reservations";
import { withStoreCapacity } from "../../runtime/sqlite/operations";

const pageSize = 8;

const retryMs = 60_000;

export const reconcileErasedHandoffs = Effect.fn(function* (
  users: Pick<DurableObjectNamespace, "getByName">
) {
  const sql = yield* SqliteClient;
  const now = yield* Clock.currentTimeMillis;

  const due = yield* withStoreCapacity("required")(
    sql`UPDATE provider_attempts SET erasure_check_ms=${now + retryMs} WHERE id IN (SELECT id FROM fenced_provider_handoffs WHERE erasure_check_ms<=${now} ORDER BY erasure_check_ms,id LIMIT ${pageSize}) RETURNING id`
  );

  yield* Effect.forEach(
    due,
    (row) =>
      Schema.decodeUnknownEffect(Schema.String)(row.id).pipe(
        Effect.flatMap((id) => cancelProviderHandoff(id, users)),
        Effect.timeout("5 seconds"),
        Effect.result
      ),
    { concurrency: 4, discard: true }
  );
});

export const outstandingDirectoryHandoffs = (userId: string): OwnedStatement => ({
  sql: `EXISTS(SELECT 1 FROM provider_attempts a JOIN browser_pairings p ON p.id=a.pairing_id WHERE p.user_id=? AND a.state='bound' AND a.acknowledged=0)
    OR EXISTS(SELECT 1 FROM identity_replacements WHERE user_id=? AND state='reserved')
    OR EXISTS(SELECT 1 FROM recovery_rotations WHERE user_id=? AND state='reserved')`,
  params: [userId, userId, userId],
});

const acknowledged = 204;

const deletionPage = 32;

const releaseIdentityHolds = Effect.fn(function* (user: string) {
  const sql = yield* SqliteClient;

  const unfinished = yield* Effect.findFirst(
    [
      ["provider_routes", "issuer,subject,creation_attempt"],
      ["whatsapp_routes", "portfolio,bsuid,attempt_id,revision"],
      ["verified_email_routes", "normalized_address,reservation_id,revision"],
      ["recovery_routes", "code_digest,attempt_id,revision,generation"],
    ] as const,
    ([table, identity]) => {
      const key = sql.unsafe(identity);

      return Effect.map(
        sql`DELETE FROM ${sql(table)} WHERE user_id=${user} AND (${key}) IN (SELECT ${key} FROM ${sql(table)} WHERE user_id=${user} LIMIT ${deletionPage}) RETURNING 1`,
        (rows) => rows.length === deletionPage
      );
    }
  );

  return Option.isNone(unfinished);
});

export const cleanDirectoryCase = Effect.fn(function* (
  scope: typeof CleanupCommand.Type,
  permission: typeof CleanupPermission.Type
) {
  const sql = yield* SqliteClient;
  const user = scope.userId;

  if (scope.action === "release") return yield* releaseIdentityHolds(user);
  const outstanding = outstandingDirectoryHandoffs(user);

  if (
    (yield* sql`SELECT 1 WHERE ${sql.unsafe(outstanding.sql, outstanding.params)}`).length !== 0
  ) {
    return false;
  }

  const admissions =
    yield* sql`DELETE FROM bootstrap_admissions WHERE id IN(SELECT id FROM bootstrap_admissions WHERE scope IN(
    SELECT 'wa:'||length(portfolio)||':'||portfolio||bsuid FROM whatsapp_routes WHERE user_id=${user} UNION ALL
    SELECT 'poll:'||verifier_digest FROM browser_pairings WHERE user_id=${user}) LIMIT 32) RETURNING 1`;

  if (admissions.length === deletionPage) return false;

  const invitations =
    yield* sql`DELETE FROM whatsapp_invitations WHERE id IN(SELECT i.id FROM browser_pairings p JOIN whatsapp_invitations i ON i.pairing_id=p.id WHERE p.user_id=${user} UNION ALL SELECT i.id FROM whatsapp_routes w JOIN whatsapp_invitations i ON i.portfolio=w.portfolio AND i.bsuid=w.bsuid WHERE w.user_id=${user} LIMIT 32) RETURNING id`;

  if (invitations.length === deletionPage) return false;

  const unfinished = yield* Effect.findFirst(
    [
      "session_routes",
      "pat_routes",
      "oauth_routes",
      "oauth_review_requests",
      "pat_bootstrap",
      "recovery_rotations",
      "identity_replacements",
      "channel_approvals",
      "support_handoffs",
      "browser_pairings",
    ],
    (table) =>
      Effect.map(
        sql`DELETE FROM ${sql(table)} WHERE rowid IN(SELECT rowid FROM ${sql(table)} WHERE user_id=${user} LIMIT 32) RETURNING 1`,
        (rows) => rows.length === deletionPage
      )
  );

  if (Option.isSome(unfinished)) return false;

  const events =
    yield* sql`DELETE FROM external_event_routes WHERE rowid IN(SELECT rowid FROM external_event_routes WHERE user_id=${user} AND (kind='forwarding' OR (kind='wompi' AND ${Number(permission.wompi)}=1) OR (kind='whatsapp' AND ${Number(permission.whatsapp)}=1)) LIMIT 32) RETURNING 1`;

  if (events.length === deletionPage) return false;

  return (
    (yield* sql`SELECT 1 FROM external_event_routes WHERE user_id=${user} LIMIT 1`).length === 0
  );
});

export const inspectDirectoryScope = Effect.fn(function* (
  request: Request,
  registry: ErasureRegistryNamespace
) {
  const admission = yield* Schema.decodeUnknownEffect(CustodyScopeAdmission, {
    onExcessProperty: "error",
  })(yield* Effect.tryPromise(() => request.json()));

  const body = yield* Schema.encodeEffect(Schema.fromJsonString(CustodyScopeAdmission))(admission);

  const permission = yield* Effect.tryPromise((signal) =>
    registry
      .getByName(erasureRegistryName)
      .fetch("https://erasure.invalid/case/confirm-scope", { method: "POST", body, signal })
  ).pipe(Effect.timeout("5 seconds"));

  if (permission.status !== acknowledged || admission.custodian === "Resend") {
    return new Response(null, { status: 409 });
  }

  const sql = yield* SqliteClient;

  const routes =
    yield* sql`SELECT r.rowid AS cursor,r.endpoint,r.lookup FROM external_event_routes r JOIN erasure_barriers b ON b.user_id=r.user_id WHERE b.user_id=${admission.userId} AND b.reference=${admission.reference} AND r.kind=${admission.custodian === "Wompi" ? "wompi" : "whatsapp"} AND r.rowid>${admission.after} ORDER BY r.rowid LIMIT 17`;

  const rows = yield* Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({ cursor: Schema.Unknown, endpoint: Schema.Unknown, lookup: Schema.Unknown })
    )
  )(routes);

  return custodyScopePage(rows);
});
