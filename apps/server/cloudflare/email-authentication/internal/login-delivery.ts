import {
  captureWorkTrace,
  sanitizeWorkTrace,
  workTraceParent,
} from "../../runtime/telemetry/operations";
import { Clock, Effect, Option, Result, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { EmailAddress } from "../../../src/core/email-authentication/contract";
import { UserId } from "../../../src/core/identity/contract";
import { NativeLoginEmailWork, loginDeliverUrl } from "../contract";
import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";
import { MailboxWriteUnavailable } from "./local-mailbox";
import { issueProofCode } from "./native-mail-delivery";
import { sendClaimedProof } from "./proof-delivery";

const cooldown = 60000,
  pageSize = 32;

const Offer = Schema.Struct({ user_id: UserId, work_id: Schema.String });

export const repairLoginAlarm = Effect.fn(function* (now: number, storage: DurableObjectStorage) {
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT min(deadline) AS deadline FROM (SELECT min(expires_at_ms) AS deadline FROM login_email_proofs UNION ALL SELECT min(offer_at_ms) FROM login_email_proofs WHERE state='awaiting_delivery' UNION ALL SELECT min(expires_at_ms) FROM browser_handoffs WHERE email_login=1)`;

  const deadline = yield* Schema.decodeUnknownEffect(Schema.OptionFromNullOr(Schema.Int))(
    row?.deadline ?? null
  );

  return Option.isSome(deadline)
    ? yield* preserveStoreAlarm(storage, Math.max(deadline.value, now))
    : false;
});

export const offerLoginEmail = Effect.fn(function* (
  queue: Pick<Queue<typeof NativeLoginEmailWork.Type>, "send">,
  storage: DurableObjectStorage
) {
  const sql = yield* SqliteClient;

  const page = yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* sql`DELETE FROM browser_handoffs WHERE email_login=1 AND id IN (SELECT id FROM browser_handoffs WHERE email_login=1 AND expires_at_ms<=${now} ORDER BY expires_at_ms LIMIT ${pageSize})`;
    yield* sql`DELETE FROM login_email_proofs WHERE work_id IN (SELECT work_id FROM login_email_proofs WHERE expires_at_ms<=${now} ORDER BY expires_at_ms LIMIT ${pageSize})`;

    const rows =
      yield* sql`UPDATE login_email_proofs SET offer_at_ms=${now + cooldown} WHERE work_id IN (SELECT work_id FROM login_email_proofs WHERE state='awaiting_delivery' AND expires_at_ms>${now} AND offer_at_ms<=${now} ORDER BY offer_at_ms LIMIT ${pageSize}) RETURNING work_id,(SELECT user_id FROM browser_handoffs p WHERE p.pairing_id=login_email_proofs.pairing_id) AS user_id`;

    yield* repairLoginAlarm(now, storage);

    return yield* Schema.decodeUnknownEffect(Schema.Array(Offer))(rows);
  }).pipe(withStoreCapacity("required"));

  const trace = yield* captureWorkTrace;

  const results = yield* Effect.forEach(
    page,
    (row) =>
      Effect.result(
        Effect.tryPromise(() =>
          queue.send({
            ...trace,
            kind: "browser-pairing-email",
            version: 2,
            id: row.work_id,
            userId: row.user_id,
          })
        )
      ),
    { concurrency: 4 }
  );

  return { attempted: page.length, failed: results.filter(Result.isFailure).length };
});

export const deliverLoginEmail = Effect.fn(function* (
  request: Request,
  env: Readonly<{ RESEND_API_KEY: string }>,
  owns: (id: string) => boolean
) {
  const work = yield* Schema.decodeUnknownEffect(NativeLoginEmailWork)(
    yield* Effect.tryPromise(() => request.json())
  );

  if (!owns(work.userId)) return new Response(null, { status: 404 });
  const sql = yield* SqliteClient;
  const { code, selector, hash } = yield* issueProofCode();

  const recipient = yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    const [row] =
      yield* sql`UPDATE login_email_proofs SET state='sending',selector=${selector},digest=${hash} WHERE work_id=${work.id} AND state='awaiting_delivery' AND expires_at_ms>${now} AND EXISTS(SELECT 1 FROM browser_handoffs p JOIN verified_email_credentials v ON v.user_id=p.user_id WHERE p.pairing_id=login_email_proofs.pairing_id AND p.user_id=${work.userId} AND p.state='pending_approval' AND p.outcome='committed' AND p.wrong_attempts<5 AND p.expires_at_ms>${now} AND v.revision=login_email_proofs.revision AND v.normalized_address=login_email_proofs.address) AND NOT EXISTS(SELECT 1 FROM erasure_requests) RETURNING address`;

    if (row === undefined) {
      yield* sql`UPDATE login_email_proofs SET state='rejected' WHERE work_id=${work.id} AND state='awaiting_delivery'`;

      return null;
    }

    return yield* Schema.decodeUnknownEffect(EmailAddress)(row.address);
  }).pipe(withStoreCapacity("required"));

  if (recipient !== null) {
    const outcome = yield* Effect.tryPromise(() =>
      sendClaimedProof({
        purpose: "browser-pairing-approval",
        environment: env,
        to: recipient,
        combinedCode: code,
        id: work.id,
        parent: workTraceParent(work),
      })
    );

    yield* sql`UPDATE login_email_proofs SET state=${outcome === "accepted" ? "awaiting_proof" : outcome},selector=CASE WHEN ${outcome}='accepted' THEN selector ELSE NULL END,digest=CASE WHEN ${outcome}='accepted' THEN digest ELSE NULL END WHERE work_id=${work.id} AND state='sending'`;
  }

  return new Response(null, { status: 204 });
});

export const startLoginWorkflow = Effect.fn(function* (
  workflow: Workflow,
  work: typeof NativeLoginEmailWork.Type
) {
  const params = yield* sanitizeWorkTrace(work);

  const start = yield* Effect.result(
    Effect.tryPromise(() => workflow.create({ id: work.id, params }))
  );

  if (Result.isSuccess(start)) return;
  const instance = yield* Effect.tryPromise(() => workflow.get(work.id));
  const { status } = yield* Effect.tryPromise(() => instance.status());

  if (status === "errored") return yield* Effect.tryPromise(() => instance.restart());

  if (!["queued", "running", "waiting", "complete"].includes(status)) {
    return yield* new MailboxWriteUnavailable();
  }
});

export const runLoginDelivery = Effect.fn(function* (
  users: Pick<DurableObjectNamespace, "getByName">,
  work: typeof NativeLoginEmailWork.Type
) {
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(NativeLoginEmailWork))(work);

  const reply = yield* Effect.tryPromise((signal) =>
    users.getByName(work.userId).fetch(loginDeliverUrl, { method: "POST", body, signal })
  );

  if (!reply.ok) return yield* new MailboxWriteUnavailable();
});
