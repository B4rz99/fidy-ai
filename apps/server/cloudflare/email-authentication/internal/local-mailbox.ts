import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { type Cause, Clock, Data, Effect, Schema } from "effect";
import { EmailAddress } from "../../../src/core/email-authentication/contract";
import { type UserId } from "../../../src/core/identity/contract";
import { type ReservedIdentity } from "../../directory/contract";
import { newId } from "../../secret-material/operations";

export class MailboxWriteUnavailable extends Data.TaggedError("MailboxWriteUnavailable") {}

export const mailboxProof = Effect.fn(function* (user: UserId) {
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT normalized_address,revision,verified_at_ms FROM verified_email_credentials WHERE user_id=${user}`;

  return yield* Schema.decodeUnknownEffect(
    Schema.OptionFromNullOr(
      Schema.Struct({
        normalized_address: EmailAddress,
        revision: Schema.Int,
        verified_at_ms: Schema.Int,
      })
    )
  )(row ?? null);
});

export const auditReplacement = Effect.fn(function* ({
  user,
  session,
  operation,
  outcome,
  now,
}: Readonly<{
  user: string;
  session: string;
  operation: "request" | "complete";
  outcome: "accepted" | "rejected" | "replaced";
  now: number;
}>) {
  const sql = yield* SqliteClient;

  const name =
    operation === "request"
      ? "emailAuthentication.requestEmailReplacement"
      : "emailAuthentication.completeEmailReplacement";

  const rows =
    yield* sql`INSERT INTO audit_entries(id,user_id,session_id,record_type,operation,outcome,occurred_at_ms) VALUES(${newId()},${user},${session},'session_call',${name},${outcome},${now}) RETURNING 1`;

  if (rows.length !== 1) return yield* new MailboxWriteUnavailable();
});

export const activateMailbox = Effect.fn(function* (change: typeof ReservedIdentity.Type) {
  const sql = yield* SqliteClient;
  const now = yield* Clock.currentTimeMillis;

  const [row] =
    yield* sql`SELECT session_id FROM email_replacements WHERE work_id=${change.id} AND user_id=${change.user_id} AND state='proven' AND candidate=${change.next_key} AND prior_key=${change.prior_key} AND revision=${change.revision} AND expires_at_ms=${change.expires_at_ms} AND expires_at_ms>${now} AND EXISTS(SELECT 1 FROM web_sessions s WHERE s.id=email_replacements.session_id AND s.user_id=email_replacements.user_id AND s.fresh_until_ms>${now} AND s.hard_expires_at_ms>${now} AND s.idle_expires_at_ms>${now} AND s.revoked_at_ms IS NULL) AND NOT EXISTS(SELECT 1 FROM erasure_requests)`;

  if (row === undefined) return false;
  const session = yield* Schema.decodeUnknownEffect(Schema.String)(row.session_id);

  const updated =
    yield* sql`UPDATE verified_email_credentials SET normalized_address=${change.next_key},revision=revision+1,verified_at_ms=${now} WHERE user_id=${change.user_id} AND revision=${change.revision} AND normalized_address=${change.prior_key} RETURNING 1`;

  if (updated.length !== 1) return false;
  const deleted = yield* sql`DELETE FROM email_replacements WHERE work_id=${change.id} RETURNING 1`;

  if (deleted.length !== 1) return yield* new MailboxWriteUnavailable();
  yield* auditReplacement({
    user: change.user_id,
    session,
    operation: "complete",
    outcome: "replaced",
    now,
  });

  return true;
});

export const mailboxSecretDigest = (
  secret: string
): Effect.Effect<Uint8Array, Cause.UnknownError> =>
  Effect.tryPromise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))).pipe(
    Effect.map((bytes) => new Uint8Array(bytes))
  );
