import { Clock, Effect, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { EmailVerificationCode } from "../../../src/core/email-authentication/contract";
import { LoginEmailHandoff } from "../contract";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import { invalidLoginProof, liveBrowserProof } from "./login-admission";
import { MailboxWriteUnavailable, mailboxSecretDigest } from "./local-mailbox";

const Verify = Schema.Struct({
  handoff: LoginEmailHandoff,
  digest: Schema.String,
  code: EmailVerificationCode,
});

const selectorLength = 9,
  secretOffset = 10;

export const verifyLoginEmail = Effect.fn(function* (
  request: Request,
  owns: (id: string) => boolean
) {
  const { handoff, digest, code } = yield* Schema.decodeUnknownEffect(Verify)(
    yield* Effect.tryPromise(() => request.json())
  );

  if (!owns(handoff.user_id)) return invalidLoginProof();

  const selector = code.slice(0, selectorLength),
    secret = yield* mailboxSecretDigest(code.slice(secretOffset));

  const sql = yield* SqliteClient;

  return yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    if (!(yield* liveBrowserProof(handoff, digest, now))) return invalidLoginProof();

    const [proof] =
      yield* sql`SELECT e.digest=${secret} AS matches FROM login_email_proofs e JOIN verified_email_credentials v ON v.user_id=${handoff.user_id} AND v.revision=e.revision AND v.normalized_address=e.address WHERE e.pairing_id=${handoff.pairing_id} AND e.selector=${selector} AND e.state='awaiting_proof' AND e.expires_at_ms>${now} AND e.wrong_attempts<5`;

    if (proof === undefined) return invalidLoginProof();

    if (proof.matches !== 1) {
      yield* sql`UPDATE login_email_proofs SET wrong_attempts=wrong_attempts+1,state=CASE WHEN wrong_attempts+1>=5 THEN 'rejected' ELSE state END,digest=CASE WHEN wrong_attempts+1>=5 THEN NULL ELSE digest END WHERE pairing_id=${handoff.pairing_id}`;

      return invalidLoginProof();
    }

    const ready =
      yield* sql`UPDATE browser_handoffs SET state='ready',last_poll_ms=NULL WHERE id=${handoff.id} AND NOT EXISTS(SELECT 1 FROM browser_handoffs WHERE state='ready' AND expires_at_ms>${now} AND wrong_attempts<5 AND ordinal>${handoff.ordinal}) RETURNING 1`;

    if (ready.length !== 1) return invalidLoginProof();
    yield* sql`UPDATE browser_handoffs SET state='invalidated' WHERE ordinal<${handoff.ordinal} AND state='ready'`;

    const used =
      yield* sql`UPDATE login_email_proofs SET state='approved',digest=NULL,selector=NULL WHERE pairing_id=${handoff.pairing_id} AND state='awaiting_proof' RETURNING 1`;

    if (used.length !== 1) return yield* new MailboxWriteUnavailable();

    return Response.json(
      { status: "pairing_approved" },
      { headers: { "cache-control": "no-store" } }
    );
  }).pipe(withStoreCapacity("required"));
});
