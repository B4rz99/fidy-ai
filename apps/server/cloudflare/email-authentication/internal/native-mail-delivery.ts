import { Clock, Effect, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import {
  EmailAddress,
  EmailVerificationCode,
} from "../../../src/core/email-authentication/contract";
import { selectEmailCodeSymbols } from "../../../src/core/email-authentication/operations";
import { UserId } from "../../../src/core/identity/contract";
import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";
import { sendClaimedProof } from "./proof-delivery";
import { MailboxWriteUnavailable, mailboxSecretDigest } from "./local-mailbox";

const publicSymbols = 8,
  secretSymbols = 16;

const Scan = Schema.Struct({ work_id: Schema.String, candidate: EmailAddress });

const symbols = (count: number): string =>
  selectEmailCodeSymbols({ bytes: crypto.getRandomValues(new Uint8Array(count)), maximum: count })
    .match(/.{4}/gu)
    ?.join("-") ?? "";

export const issueProofCode = Effect.fn(function* () {
  const selector = symbols(publicSymbols),
    secret = symbols(secretSymbols);

  return {
    selector,
    code: yield* Schema.decodeEffect(EmailVerificationCode)(selector + "-" + secret),
    hash: yield* mailboxSecretDigest(secret),
  };
});

export const deliverPendingReplacement = Effect.fn(function* (
  environment: Readonly<{ RESEND_API_KEY: string }>,
  storage: DurableObjectStorage,
  owns: (id: string) => boolean
) {
  const sql = yield* SqliteClient;
  const now = yield* Clock.currentTimeMillis;
  yield* sql`DELETE FROM email_replacements WHERE expires_at_ms<=${now}`;

  const [raw] =
    yield* sql`SELECT work_id,candidate FROM email_replacements WHERE state='awaiting_delivery' LIMIT 1`;

  if (raw === undefined) return { attempted: 0, failed: 0 };
  const work = yield* Schema.decodeUnknownEffect(Scan)(raw);
  const { selector, code, hash } = yield* issueProofCode();

  const claimed = yield* Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;

    const [row] =
      yield* sql`UPDATE email_replacements SET state='sending',public_code=${selector},proof_digest=${hash} WHERE work_id=${work.work_id} AND state='awaiting_delivery' AND expires_at_ms>${current} AND EXISTS(SELECT 1 FROM web_sessions s WHERE s.id=email_replacements.session_id AND s.user_id=email_replacements.user_id AND s.fresh_until_ms>${current} AND s.idle_expires_at_ms>${current} AND s.hard_expires_at_ms>${current} AND s.revoked_at_ms IS NULL) AND EXISTS(SELECT 1 FROM verified_email_credentials v WHERE v.user_id=email_replacements.user_id AND v.revision=email_replacements.revision AND v.normalized_address=email_replacements.prior_key) AND NOT EXISTS(SELECT 1 FROM erasure_requests) RETURNING user_id,expires_at_ms`;

    if (row === undefined) {
      yield* sql`UPDATE email_replacements SET state='rejected' WHERE work_id=${work.work_id} AND state='awaiting_delivery'`;

      return false;
    }

    if (!owns(yield* Schema.decodeUnknownEffect(UserId)(row.user_id))) {
      return yield* new MailboxWriteUnavailable();
    }

    yield* preserveStoreAlarm(
      storage,
      yield* Schema.decodeUnknownEffect(Schema.Int)(row.expires_at_ms)
    );

    return true;
  }).pipe(withStoreCapacity("required"));

  if (!claimed) return { attempted: 0, failed: 0 };

  const result = yield* Effect.tryPromise(() =>
    sendClaimedProof({
      purpose: "credential-replacement",
      environment,
      to: work.candidate,
      combinedCode: code,
      id: work.work_id,
      parent: undefined,
    })
  );

  yield* sql`UPDATE email_replacements SET state=${result === "accepted" ? "awaiting_proof" : result},proof_digest=CASE WHEN ${result}='accepted' THEN proof_digest ELSE NULL END WHERE work_id=${work.work_id} AND state='sending'`;

  return { attempted: 1, failed: 0 };
});
