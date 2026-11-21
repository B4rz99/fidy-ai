import { Clock, Effect, Option, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { EmailAddress } from "../../../src/core/email-authentication/contract";

import { UserId } from "../../../src/core/identity/contract";
import {
  CompleteEmailReplacementPayload,
  RequestEmailReplacementPayload,
  emailReplacementCompletionPath,
  emailReplacementFreshBody,
  emailReplacementInvalidBody,
  emailReplacementUnavailableBody,
} from "../../../src/shell/email-authentication/contract";
import {
  type UserStoreBindings,
  directoryName,
  emailRouteUrl,
  replaceIdentityUrl,
} from "../../directory/contract";
import { canonicalAdmissionUnavailable } from "../../canonical-admission/operations";
import { readBoundWebSessionProof } from "../../web-session/operations";
import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";
import { RequestBodyPolicy } from "../../http/contract";
import { boundedJsonBody } from "../../http/operations";
import { newId } from "../../secret-material/operations";

import {
  MailboxWriteUnavailable,
  auditReplacement,
  mailboxProof,
  mailboxSecretDigest,
} from "./local-mailbox";

const day = 86400000,
  life = 600000,
  limit = 5,
  publicLength = 9,
  secretOffset = 10;

const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 512,
  deadlineMilliseconds: 2000,
});

const isResponse = Schema.is(Schema.instanceOf(Response));

const invalidStatus = 400,
  unauthorizedStatus = 401,
  missingStatus = 404,
  conflictStatus = 409,
  unavailableStatus = 503;

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const invalid = (): Response => json(emailReplacementInvalidBody, invalidStatus);

const fresh = (): Response => json(emailReplacementFreshBody, unauthorizedStatus);

const pending = (): Response => json({ data: { status: "pending" }, next: [] });

type Proof = { digest: Uint8Array; binding: string };

type Env = { DIRECTORY: UserStoreBindings["DIRECTORY"] };

const live = Effect.fn(function* (proof: Proof, owns: (id: string) => boolean, now: number) {
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT user_id FROM web_sessions WHERE id=${proof.binding} AND token_digest=${proof.digest} AND fresh_until_ms>${now} AND idle_expires_at_ms>${now} AND hard_expires_at_ms>${now} AND revoked_at_ms IS NULL AND NOT EXISTS(SELECT 1 FROM erasure_requests)`;

  const user = yield* Schema.decodeUnknownEffect(Schema.OptionFromNullOr(UserId))(
    row?.user_id ?? null
  );

  return Option.filter(user, owns);
});

const start = Effect.fn(function* ({
  proof,
  owns,
  candidate,
  free,
  storage,
}: Readonly<{
  proof: Proof;
  owns: (id: string) => boolean;
  candidate: EmailAddress;
  free: boolean;
  storage: DurableObjectStorage;
}>) {
  const sql = yield* SqliteClient;
  const now = yield* Clock.currentTimeMillis;
  const owner = yield* live(proof, owns, now);

  if (Option.isNone(owner)) return fresh();
  const user = owner.value;
  const mailbox = yield* mailboxProof(user);
  yield* auditReplacement({
    user,
    session: proof.binding,
    operation: "request",
    outcome: "accepted",
    now,
  });

  if (!free || Option.isNone(mailbox) || mailbox.value.normalized_address === candidate) {
    return pending();
  }

  const occupied =
    yield* sql`SELECT 1 FROM email_replacements WHERE user_id=${user} AND expires_at_ms>${now} AND state NOT IN ('rejected','ambiguous')`;

  if (occupied.length !== 0) return pending();

  const allowed =
    yield* sql`INSERT INTO email_replacement_limits VALUES(${user},${now + day},1) ON CONFLICT(user_id) DO UPDATE SET reset_at_ms=CASE WHEN reset_at_ms<=${now} THEN excluded.reset_at_ms ELSE reset_at_ms END,used=CASE WHEN reset_at_ms<=${now} THEN 1 ELSE used+1 END WHERE reset_at_ms<=${now} OR used<${limit} RETURNING 1`;

  if (allowed.length !== 1) return pending();
  yield* sql`DELETE FROM email_replacements WHERE user_id=${user}`;

  const record =
    yield* sql`INSERT INTO email_replacements(user_id,work_id,session_id,prior_key,revision,candidate,created_at_ms,expires_at_ms,state) VALUES(${user},${newId()},${proof.binding},${mailbox.value.normalized_address},${mailbox.value.revision},${candidate},${now},${now + life},'awaiting_delivery') RETURNING 1`;

  if (record.length !== 1) return yield* new MailboxWriteUnavailable();
  yield* preserveStoreAlarm(storage, now).pipe(
    Effect.catch(() =>
      Effect.logWarning({
        component: "email-authentication",
        operation: "requestEmailReplacement",
        outcome: "alarm-unscheduled",
      })
    )
  );

  return pending();
});

const Ready = Schema.Struct({
  id: Schema.String,
  user_id: UserId,
  prior_key: EmailAddress,
  next_key: EmailAddress,
  revision: Schema.Int,
  occurred_at_ms: Schema.Int,
  expires_at_ms: Schema.Int,
  matches: Schema.Int,
});

const prove = Effect.fn(function* ({
  proof,
  owns,
  payload,
  bytes,
}: Readonly<{
  proof: Proof;
  owns: (id: string) => boolean;
  payload: CompleteEmailReplacementPayload;
  bytes: Uint8Array;
}>) {
  const sql = yield* SqliteClient;
  const now = yield* Clock.currentTimeMillis;
  const owner = yield* live(proof, owns, now);

  if (Option.isNone(owner)) return fresh();

  const [raw] =
    yield* sql`SELECT row.work_id AS id,row.user_id,row.prior_key,row.candidate AS next_key,row.revision,row.created_at_ms AS occurred_at_ms,row.expires_at_ms,row.proof_digest=${bytes} AS matches FROM email_replacements row JOIN verified_email_credentials v ON v.user_id=row.user_id AND v.revision=row.revision AND v.normalized_address=row.prior_key WHERE row.user_id=${owner.value} AND row.session_id=${proof.binding} AND row.state IN ('awaiting_proof','proven') AND row.candidate=${payload.candidateEmail} AND row.public_code=${payload.combinedCode.slice(0, publicLength)} AND row.expires_at_ms>${now} AND row.wrong_attempts<${limit}`;

  const row = yield* Schema.decodeUnknownEffect(Schema.OptionFromNullOr(Ready))(raw ?? null);

  if (Option.isNone(row) || row.value.matches !== 1) {
    yield* auditReplacement({
      user: owner.value,
      session: proof.binding,
      operation: "complete",
      outcome: "rejected",
      now,
    });

    if (Option.isSome(row)) {
      yield* sql`UPDATE email_replacements SET wrong_attempts=wrong_attempts+1,state=CASE WHEN wrong_attempts+1>=${limit} THEN 'rejected' ELSE state END,proof_digest=CASE WHEN wrong_attempts+1>=${limit} THEN NULL ELSE proof_digest END WHERE work_id=${row.value.id} AND state='awaiting_proof'`;
    }

    return invalid();
  }

  yield* sql`UPDATE email_replacements SET state='proven' WHERE work_id=${row.value.id}`;

  return row.value;
});

const rejectProof = Effect.fn(function* (proof: Proof, owns: (id: string) => boolean) {
  const now = yield* Clock.currentTimeMillis;
  const user = yield* live(proof, owns, now);

  if (Option.isNone(user)) return fresh();
  yield* auditReplacement({
    user: user.value,
    session: proof.binding,
    operation: "complete",
    outcome: "rejected",
    now,
  });

  return invalid();
});

const requestCandidate = Effect.fn(function* ({
  request,
  proof,
  owns,
  storage,
  directory,
}: Readonly<{
  request: Request;
  proof: Proof;
  owns: (id: string) => boolean;
  storage: DurableObjectStorage;
  directory: Pick<Fetcher, "fetch">;
}>) {
  const payload = yield* boundedJsonBody({
    request,
    policy,
    schema: RequestEmailReplacementPayload,
  });

  if (Option.isNone(payload)) return invalid();

  const check = yield* Effect.tryPromise((signal) =>
    directory.fetch(emailRouteUrl, {
      method: "POST",
      body: payload.value.candidateEmail,
      signal,
    })
  );

  if (!check.ok && check.status !== missingStatus) return canonicalAdmissionUnavailable();

  return yield* start({
    proof,
    owns,
    candidate: payload.value.candidateEmail,
    free: check.status === missingStatus,
    storage,
  }).pipe(withStoreCapacity("growth"));
});

export const replacementRequest = Effect.fn(
  function* ({
    request,
    environment,
    owns,
    storage,
  }: Readonly<{
    request: Request;
    environment: Env;
    owns: (id: string) => boolean;
    storage: DurableObjectStorage;
  }>) {
    const proof = yield* Effect.tryPromise(() => readBoundWebSessionProof(request));

    if (Option.isNone(proof)) return fresh();
    const directory = environment.DIRECTORY.getByName(directoryName);

    if (new URL(request.url).pathname !== emailReplacementCompletionPath) {
      return yield* requestCandidate({ request, proof: proof.value, owns, storage, directory });
    }

    const payload = yield* boundedJsonBody({
      request,
      policy,
      schema: CompleteEmailReplacementPayload,
    });

    if (Option.isNone(payload)) {
      return yield* rejectProof(proof.value, owns).pipe(withStoreCapacity("required"));
    }

    const bytes = yield* mailboxSecretDigest(payload.value.combinedCode.slice(secretOffset));

    const row = yield* prove({ proof: proof.value, owns, payload: payload.value, bytes }).pipe(
      withStoreCapacity("required")
    );

    if (isResponse(row)) return row;

    const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      ...row,
      kind: "email",
      scope: "",
      expected_user: row.user_id,
    });

    const changed = yield* Effect.tryPromise((signal) =>
      directory.fetch(replaceIdentityUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal,
      })
    );

    if (changed.ok) return json({ data: { status: "replaced" }, next: [] });

    return changed.status === conflictStatus
      ? yield* rejectProof(proof.value, owns).pipe(withStoreCapacity("required"))
      : json(emailReplacementUnavailableBody, unavailableStatus);
  },
  Effect.tapCause(() =>
    Effect.logWarning({
      component: "email-authentication",
      operation: "completeEmailReplacement",
      outcome: "unavailable",
    })
  ),
  Effect.catchCause(() => Effect.succeed(json(emailReplacementUnavailableBody, unavailableStatus)))
);

export const repairReplacementAlarm = Effect.fn(function* (
  now: number,
  storage: DurableObjectStorage
) {
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT CASE WHEN state='awaiting_delivery' THEN ${now} ELSE expires_at_ms END AS deadline FROM email_replacements LIMIT 1`;

  return row === undefined
    ? false
    : yield* preserveStoreAlarm(
        storage,
        Math.max(now, yield* Schema.decodeUnknownEffect(Schema.Int)(row.deadline))
      );
});
