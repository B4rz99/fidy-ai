import { Clock, Effect, Option, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { EmailAddress } from "../../../src/core/email-authentication/contract";
import { browserPairingEmailAuthenticationInvalidBody } from "../../../src/shell/email-authentication/contract";
import { LoginEmailHandoff, LoginMailboxCandidate, loginAllowanceUrl } from "../contract";
import { directoryName } from "../../directory/contract";
import { newId } from "../../secret-material/operations";
import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";
import { MailboxWriteUnavailable, mailboxProof } from "./local-mailbox";

export const invalidLoginProof = (): Response =>
  Response.json(browserPairingEmailAuthenticationInvalidBody, {
    status: 400,
    headers: { "cache-control": "no-store" },
  });

const pending = (): Response =>
  Response.json(
    { status: "pending", retryAfterSeconds: 60 },
    { status: 202, headers: { "cache-control": "no-store" } }
  );

const hour = 3600000,
  cooldown = 60000,
  maxRequests = 5;

const Start = Schema.Struct({
  handoff: LoginEmailHandoff,
  digest: Schema.String,
  revision: Schema.NullOr(Schema.Int),
  address: EmailAddress,
});

type Input = typeof Start.Type;

export const liveBrowserProof = Effect.fn(function* (
  handoff: typeof LoginEmailHandoff.Type,
  digest: string,
  now: number
) {
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT verifier_digest=${digest} AS matches FROM browser_handoffs WHERE id=${handoff.id} AND pairing_id=${handoff.pairing_id} AND user_id=${handoff.user_id} AND state='pending_approval' AND outcome='committed' AND wrong_attempts<5 AND expires_at_ms>${now} AND NOT EXISTS(SELECT 1 FROM erasure_requests)`;

  if (row === undefined) return false;

  if (row.matches === 1) return true;
  yield* sql`UPDATE browser_handoffs SET wrong_attempts=wrong_attempts+1,state=CASE WHEN wrong_attempts+1>=5 THEN 'invalidated' ELSE state END WHERE id=${handoff.id}`;

  return false;
});

const receiveHandoff = Effect.fn(function* (handoff: typeof LoginEmailHandoff.Type) {
  const sql = yield* SqliteClient;
  yield* sql`INSERT INTO browser_handoffs(id,pairing_id,user_id,ordinal,verifier_digest,expires_at_ms,wrong_attempts,last_poll_ms,minimum_poll_seconds,outcome,state,email_login) SELECT ${handoff.id},${handoff.pairing_id},${handoff.user_id},${handoff.ordinal},${handoff.verifier_digest},${handoff.expires_at_ms},${handoff.wrong_attempts},${handoff.last_poll_ms},${handoff.minimum_poll_seconds},'committed','pending_approval',1 FROM users WHERE id=${handoff.user_id} AND lifetime_registered=1 AND NOT EXISTS(SELECT 1 FROM erasure_requests) ON CONFLICT(pairing_id) DO NOTHING`;
});

const eligible = Effect.fn(function* (input: Input, now: number) {
  const sql = yield* SqliteClient;
  const mailbox = yield* mailboxProof(input.handoff.user_id);

  if (
    Option.isNone(mailbox) ||
    mailbox.value.normalized_address !== input.address ||
    mailbox.value.revision !== input.revision
  ) {
    return false;
  }

  const block =
    yield* sql`SELECT 1 FROM login_email_window WHERE reset_at_ms>${now} AND used>=${maxRequests} UNION ALL SELECT 1 FROM login_email_proofs WHERE pairing_id=${input.handoff.pairing_id} AND (state IN ('approved','sending') OR generation>=${maxRequests} OR requested_at_ms>${now - cooldown}) LIMIT 1`;

  return block.length === 0;
});

const accept = Effect.fn(function* (input: Input, storage: DurableObjectStorage) {
  const sql = yield* SqliteClient,
    now = yield* Clock.currentTimeMillis;

  if (!(yield* liveBrowserProof(input.handoff, input.digest, now))) return invalidLoginProof();

  if (!(yield* eligible(input, now))) return pending();

  const charged =
    yield* sql`INSERT INTO login_email_window VALUES(1,${now + hour},1) ON CONFLICT(singleton) DO UPDATE SET reset_at_ms=CASE WHEN reset_at_ms<=${now} THEN excluded.reset_at_ms ELSE reset_at_ms END,used=CASE WHEN reset_at_ms<=${now} THEN 1 ELSE used+1 END WHERE reset_at_ms<=${now} OR used<${maxRequests} RETURNING 1`;

  if (charged.length !== 1) return pending();

  const work =
    yield* sql`INSERT INTO login_email_proofs(pairing_id,work_id,address,revision,generation,requested_at_ms,expires_at_ms,offer_at_ms,state) VALUES(${input.handoff.pairing_id},${newId()},${input.address},${input.revision},1,${now},${input.handoff.expires_at_ms},${now},'awaiting_delivery') ON CONFLICT(pairing_id) DO UPDATE SET work_id=excluded.work_id,address=excluded.address,revision=excluded.revision,generation=generation+1,requested_at_ms=excluded.requested_at_ms,offer_at_ms=excluded.offer_at_ms,state=excluded.state,selector=NULL,digest=NULL,delivery_key=NULL,wrong_attempts=0 RETURNING 1`;

  if (work.length !== 1) return yield* new MailboxWriteUnavailable();
  yield* preserveStoreAlarm(storage, now).pipe(Effect.ignore);

  return pending();
});

export const checkLoginMailbox = Effect.fn(function* (
  request: Request,
  owns: (id: string) => boolean
) {
  const input = yield* Schema.decodeUnknownEffect(LoginMailboxCandidate)(
    yield* Effect.tryPromise(() => request.json())
  );

  const mailbox = yield* mailboxProof(input.user_id);

  if (!owns(input.user_id) || Option.isNone(mailbox)) return new Response(null, { status: 404 });

  const sql = yield* SqliteClient,
    now = yield* Clock.currentTimeMillis;

  const blocked =
    yield* sql`SELECT 1 FROM erasure_requests UNION ALL SELECT 1 FROM login_email_window WHERE reset_at_ms>${now} AND used>=${maxRequests} LIMIT 1`;

  const matches =
    mailbox.value.normalized_address === input.address && mailbox.value.revision === input.revision;

  const allowedStatus = 204,
    missingStatus = 404;

  return new Response(null, {
    status: matches && blocked.length === 0 ? allowedStatus : missingStatus,
  });
});

export const startLoginEmail = Effect.fn(function* ({
  request,
  directory,
  storage,
  owns,
}: Readonly<{
  request: Request;
  directory: Pick<DurableObjectNamespace, "getByName">;
  storage: DurableObjectStorage;
  owns: (id: string) => boolean;
}>) {
  const input = yield* Schema.decodeUnknownEffect(Start)(
    yield* Effect.tryPromise(() => request.json())
  );

  if (!owns(input.handoff.user_id)) return pending();

  const preflight = yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    if (input.handoff.expires_at_ms <= now) return invalidLoginProof();
    yield* receiveHandoff(input.handoff);
    yield* preserveStoreAlarm(storage, input.handoff.expires_at_ms).pipe(Effect.ignore);

    if (!(yield* liveBrowserProof(input.handoff, input.digest, now))) return invalidLoginProof();

    return (yield* eligible(input, now)) ? null : pending();
  }).pipe(withStoreCapacity("growth"));

  if (preflight !== null) return preflight;

  const allowance = yield* Effect.tryPromise((signal) =>
    directory.getByName(directoryName).fetch(loginAllowanceUrl, { method: "POST", signal })
  );

  const allowedStatus = 204,
    throttledStatus = 429;

  if (allowance.status === throttledStatus) return pending();

  if (allowance.status !== allowedStatus) return yield* new MailboxWriteUnavailable();

  return yield* accept(input, storage).pipe(withStoreCapacity("growth"));
});
