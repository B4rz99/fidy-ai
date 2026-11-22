import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { DateTime, Effect, Schema } from "effect";
import { Account, Connection, InstitutionId } from "../../../src/core/connections/contract";
import type { UserId } from "../../../src/core/identity/contract";
import {
  type CanonicalRejection,
  type LocalMutationResult,
  notFoundRejection,
  validationRejection,
} from "../../canonical-admission/contract";
import { preserveStoreAlarm } from "../../runtime/sqlite/operations";
import { newId } from "../../secret-material/operations";
import { prepareLocalWrite } from "../../canonical-admission/operations";
import { admissionFailure } from "../../canonical-admission/rejection";
import { institutionsForUser } from "./institution-registration";

const accountPosition = -2;

const maxAccounts = 1000;

const success = (data: Schema.Json): LocalMutationResult => ({
  status: 200,
  outcome: "success",
  body: { data, next: [] },
});

const missing = (): CanonicalRejection => notFoundRejection("Connection unavailable.");

export const queryConnections = Effect.fn(function* (
  operation: string,
  request: Request,
  user: UserId
) {
  const sql = yield* SqliteClient;

  const all = yield* Schema.decodeUnknownEffect(Schema.Array(Connection))(
    yield* sql`SELECT id,institution_id AS institutionId,state FROM connections WHERE user_id=${user} ORDER BY institution_id,id`
  );

  if (operation === "connections.listConnections") return success([...all]);

  if (operation === "connections.listInstitutions") {
    const first = all[0];

    return success([
      {
        id: "bancolombia",
        displayName: "Bancolombia",
        availability: (yield* institutionsForUser(user)).includes(InstitutionId.make("bancolombia"))
          ? "available"
          : "unavailable",
        connection: first !== undefined ? { id: first.id, state: first.state } : null,
      },
    ]);
  }

  const accounts = operation === "connections.listAccounts";
  const id = new URL(request.url).pathname.split("/").at(accounts ? accountPosition : -1);
  const connection = all.find((item) => item.id === id);

  if (connection === undefined) return yield* missing();

  if (!accounts) return success(connection);

  const rows =
    yield* sql`SELECT r.id,r.connection_id AS connectionId FROM connection_accounts r JOIN connection_grants g ON g.attempt_id=r.grant_attempt_id WHERE r.connection_id=${connection.id} AND ${connection.state}='Active' AND g.state='active' ORDER BY r.id LIMIT ${maxAccounts}`;

  return success([...(yield* Schema.decodeUnknownEffect(Schema.Array(Account))(rows))]);
}, Effect.mapError(admissionFailure));

const unavailableInstitution = (found: boolean): CanonicalRejection =>
  found
    ? validationRejection("Institution unavailable.")
    : notFoundRejection("Institution unavailable.");

const attemptLifetime = 600000;

const retentionLifetime = 86400000;

export const prepareConnection = Effect.fn(function* (
  id: InstitutionId,
  { user, current, storage }: { user: UserId; current: number; storage: DurableObjectStorage }
) {
  if (id !== "bancolombia") return yield* unavailableInstitution(false);

  if (!(yield* institutionsForUser(user)).includes(id)) return yield* unavailableInstitution(true);

  return prepareLocalWrite({
    targets: ["connections:" + id],
    commit: Effect.gen(function* () {
      const sql = yield* SqliteClient;
      yield* sql`UPDATE connection_attempts SET status='invalidated' WHERE status='pending' AND connection_id IN
        (SELECT id FROM connections WHERE user_id=${user} AND institution_id=${id} AND (state IN ('Action required','Ended') OR connection_attempts.expires_at_ms<=${current}))`;
      yield* sql`DELETE FROM connection_attempts WHERE status!='pending' AND expires_at_ms<=${current - retentionLifetime} AND connection_id IN (SELECT id FROM connections WHERE user_id=${user})
        AND NOT EXISTS(SELECT 1 FROM connection_authorizations b WHERE b.attempt_id=connection_attempts.id AND b.consent_id IS NOT NULL)`;

      const [row] =
        yield* sql`INSERT INTO connections(id,user_id,institution_id,state,created_at_ms,updated_at_ms)
        VALUES(${newId()},${user},${id},'Connecting',${current},${current}) ON CONFLICT(user_id,institution_id) DO UPDATE SET
        state=CASE WHEN connections.state='Active' THEN 'Active' ELSE 'Connecting' END,
        updated_at_ms=CASE WHEN connections.state IN ('Connecting','Active') THEN connections.updated_at_ms ELSE excluded.updated_at_ms END
        RETURNING id,institution_id AS institutionId,state`;

      const connection = yield* Schema.decodeUnknownEffect(Connection)(row);

      if (connection.state === "Active") return success({ type: "already_connected", connection });
      yield* sql`INSERT INTO connection_attempts(id,connection_id,public_reference,status,created_at_ms,expires_at_ms)
        SELECT ${newId()},${connection.id},${newId()},'pending',${current},${current + attemptLifetime} WHERE NOT EXISTS(SELECT 1 FROM connection_attempts WHERE connection_id=${connection.id} AND status='pending')`;

      const [pending] =
        yield* sql`SELECT public_reference,expires_at_ms FROM connection_attempts WHERE connection_id=${connection.id} AND status='pending'`;

      const attempt = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          public_reference: Schema.String.check(Schema.isUUID()),
          expires_at_ms: Schema.Int,
        })
      )(pending);

      yield* preserveStoreAlarm(storage, attempt.expires_at_ms + retentionLifetime);

      return success({
        type: "continue_in_browser",
        connection,
        continuation: {
          url: "https://app.fidyapp.com/connections/continue?attempt=" + attempt.public_reference,
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(attempt.expires_at_ms)),
        },
      });
    }),
  });
});
