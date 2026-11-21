import { HostedPauseNotice } from "../../insights/contract";
import type { LocalTurn } from "./local-turn";
import { visibleChallenge } from "./local-challenge";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Data, DateTime, Effect, Option, Schema } from "effect";
import { Hex } from "effect/encoding";
import {
  AgentIteration,
  HostedAgentSessionId,
  TranscriptEntry,
  TranscriptEntryId,
  TranscriptText,
  TranscriptTurnId,
} from "../../../src/core/agent/contract";
import { hostedSessionIdleMilliseconds } from "../../../src/core/agent/operations";
import { UserContext, UserId } from "../../../src/core/identity/contract";
import {
  type ConsentSubject,
  DisclosureSnapshot,
  OnboardingConsentBasis,
} from "../../../src/shell/consent/contract";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { activeProUserCondition } from "../../../src/shell/access-tier/operations";
import {
  boundSecuritySessionLookup,
  readBoundWebSessionProof,
  resolveBoundCanonicalWebSession,
} from "../../web-session/operations";
import { preserveStoreAlarm } from "../../runtime/sqlite/operations";
import { digestBytes, newId } from "../../secret-material/operations";
import { deliveryAcknowledgmentWindowMs, pendingExecutionRecoveryMs } from "../contract";

export const channelStatus = {
  accepted: 202,
  ok: 200,
  invalid: 400,
  unauthenticated: 401,
  forbidden: 403,
  conflict: 409,
  quota: 429,
  unavailable: 503,
} as const;

const receiptBytes = 32;

const Entry = Data.taggedEnum<TranscriptEntry>();

const Subject = Data.taggedEnum<ConsentSubject>();

export const channelReply =
  (status: number) =>
  (body: unknown): Response =>
    Response.json(body, { status, headers: { "cache-control": "no-store" } });

export const isResponse = Schema.is(Schema.instanceOf(Response));

export const unavailable = (): Response =>
  channelReply(channelStatus.unavailable)({ status: "unavailable" });

export const turnProof = Effect.fn(function* (request: Request, owns: (id: string) => boolean) {
  const proof = yield* Effect.tryPromise(() => readBoundWebSessionProof(request));

  return Effect.fn(function* (now: number) {
    if (Option.isNone(proof)) return Option.none();
    const lookup = boundSecuritySessionLookup({ ...proof.value, current: now });
    const sql = yield* SqliteClient;

    const [row] = yield* sql.unsafe(
      lookup.statement.sql +
        " AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=web_sessions.user_id)",
      lookup.statement.params
    );

    return Option.filter(resolveBoundCanonicalWebSession({ lookup, row }), (held) =>
      owns(held.userId)
    );
  });
});

export const appendEntry = Effect.fn(function* (session: string, entry: TranscriptEntry) {
  const sql = yield* SqliteClient;

  const body = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.toCodecJson(TranscriptEntry))
  )(entry);

  yield* sql`INSERT INTO hosted_transcript(session_id,turn_id,entry_json) VALUES(${session},${entry.turnId},${body})`;
});

export const entryIdentity =
  (turnId: TranscriptTurnId) =>
  (now: number): Pick<TranscriptEntry, "id" | "turnId" | "occurredAt"> => ({
    id: TranscriptEntryId.make(newId()),
    turnId,
    occurredAt: DateTime.makeUnsafe(now),
  });

export const finishTurn = Effect.fn(function* (
  { turnId, user }: { turnId: TranscriptTurnId; user: string },
  reason: "interrupted" | "failed",
  now: number
) {
  const sql = yield* SqliteClient;

  const marked =
    yield* sql`UPDATE hosted_turns SET state=${reason},terminal_ms=${now},receipt_digest=NULL,receipt_value=NULL,answer=NULL WHERE id=${turnId} AND user_id=${user} AND state IN ('queued','running','proposed') RETURNING session_id`;

  if (marked.length === 0) return;
  const session = yield* Schema.decodeUnknownEffect(HostedAgentSessionId)(marked[0]?.session_id);
  const identity = entryIdentity(turnId)(now);
  yield* appendEntry(
    session,
    reason === "interrupted"
      ? Entry.InterruptedTurnTranscriptEntry(identity)
      : Entry.FailedTurnTranscriptEntry({ ...identity, reason: "HostedInferenceFailed" })
  );
  yield* sql`UPDATE hosted_agent_sessions SET active_ms=${now} WHERE id=${session}`;
});

const basisFor = Effect.fn(function* (user: UserId) {
  const guard = protectConsentStatement({
    statement: {
      sql: "SELECT id,disclosure_json FROM consent_history WHERE user_id=? AND record_type='processing_grant'",
      params: [user],
    },
    subject: Subject.User({ userId: user }),
    requirement: "active",
  });

  const sql = yield* SqliteClient;
  const [row] = yield* sql.unsafe(guard.sql, guard.params);

  if (row === undefined) return Option.none();

  const record = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ id: Schema.String, disclosure_json: Schema.fromJsonString(DisclosureSnapshot) })
  )(row);

  const doc = record.disclosure_json;

  const basis = yield* Schema.decodeEffect(OnboardingConsentBasis)({
    grantId: record.id,
    disclosureRevision: doc.revision,
    disclosureSha256: doc.contentSha256,
    policyRevision: doc.policy.revision,
    policySha256: doc.policy.contentSha256,
  });

  return Option.some(
    yield* Schema.encodeEffect(Schema.fromJsonString(OnboardingConsentBasis))(basis)
  );
});

export const turnBudget = Effect.fn(function* (user: UserId, now: number) {
  const sql = yield* SqliteClient;
  const pro = activeProUserCondition({ userId: user, nowEpochMs: now });

  const day = 86400000,
    start = now - (now % day);

  const [row] = yield* sql.unsafe(
    `SELECT count(*) < CASE WHEN ${pro.sql} THEN 50 ELSE 10 END AS available FROM hosted_turns WHERE user_id=? AND start_ms>=? AND start_ms<?`,
    [...pro.params, user, start, start + day]
  );

  return (
    (yield* Schema.decodeUnknownEffect(Schema.Struct({ available: Schema.Literals([0, 1]) }))(row))
      .available === 1
  );
});

export const beginTurn = Effect.fn(function* (
  actor: { userId: string; id: Option.Option<string> },
  text: TranscriptText,
  storage: DurableObjectStorage
) {
  const current = yield* Clock.currentTimeMillis;
  const user = yield* Schema.decodeEffect(UserId)(actor.userId);
  const basis = yield* basisFor(user);

  if (Option.isNone(basis)) {
    return channelReply(channelStatus.forbidden)({ status: "user_action_required" });
  }

  const sql = yield* SqliteClient;

  const [pending] =
    yield* sql`SELECT id FROM hosted_turns WHERE user_id=${user} AND state IN ('queued','running','proposed')`;

  if (pending !== undefined) {
    return channelReply(channelStatus.conflict)({ status: "awaiting_delivery" });
  }

  if (!(yield* turnBudget(user, current))) {
    return channelReply(channelStatus.quota)({ status: "capacity_exceeded" });
  }

  const [previous] =
    yield* sql`SELECT id FROM hosted_agent_sessions WHERE user_id=${user} AND active_ms>${current - hostedSessionIdleMilliseconds} AND NOT EXISTS(SELECT 1 FROM consent_history c WHERE c.user_id=hosted_agent_sessions.user_id AND c.record_type='processing_withdrawal' AND c.occurred_at_ms>=hosted_agent_sessions.start_ms) ORDER BY active_ms DESC,rowid DESC LIMIT 1`;

  const session =
    previous === undefined
      ? HostedAgentSessionId.make(newId())
      : yield* Schema.decodeUnknownEffect(HostedAgentSessionId)(previous.id);

  if (previous === undefined) {
    yield* sql`INSERT INTO hosted_agent_sessions(id,user_id,basis_json,start_ms,active_ms) VALUES(${session},${user},${basis.value},${current},${current})`;
  }

  const id = TranscriptTurnId.make(newId());
  yield* sql`INSERT INTO hosted_turns(id,user_id,session_id,browser_id,start_ms,deadline_ms,request_text,state) VALUES(${id},${user},${session},${Option.getOrNull(actor.id)},${current},${current + pendingExecutionRecoveryMs},${text},'queued')`;
  yield* (yield* HostedPauseNotice).bind({ id, user, session }, previous === undefined);
  yield* appendEntry(session, Entry.UserTranscriptEntry({ ...entryIdentity(id)(current), text }));
  yield* preserveStoreAlarm(storage, current);

  return {
    id,
    user_id: user,
    session_id: session,
    browser_id: actor.id,
    start_ms: current,
    deadline_ms: current + pendingExecutionRecoveryMs,
    request_text: text,
  } satisfies LocalTurn;
});

export const liveTurn = Effect.fn(function* (
  turn: LocalTurn,
  now: number,
  state: "queued" | "running" = "running"
) {
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT u.service_market AS serviceMarket,u.locale,u.time_zone AS timeZone FROM hosted_turns t
    JOIN users u ON u.id=t.user_id JOIN hosted_agent_sessions s ON s.user_id=u.id AND s.id=t.session_id
    LEFT JOIN web_sessions w ON w.user_id=u.id AND w.id=t.browser_id
    WHERE t.id=${turn.id} AND t.user_id=${turn.user_id} AND s.id=${turn.session_id} AND t.state=${state} AND t.deadline_ms>${now}
    AND ((w.id IS NOT NULL AND w.revoked_at_ms IS NULL AND w.hard_expires_at_ms>${now} AND w.idle_expires_at_ms>${now}) OR
      (t.browser_id IS NULL AND EXISTS(SELECT 1 FROM hosted_whatsapp_inbound i WHERE i.turn_id=t.id AND i.user_id=u.id AND i.portfolio=u.whatsapp_portfolio_id AND i.bsuid=u.whatsapp_bsuid AND u.whatsapp_verified_at_ms<=i.occurred_ms+999)))
    AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=u.id)`;

  return yield* Schema.decodeUnknownEffect(UserContext)(row);
});

const receiptHash = Effect.fnUntraced(function* (value: string) {
  return Hex.encode(yield* digestBytes(new TextEncoder().encode(value)));
});

const completedReceipt = Effect.fn(function* (
  input: { turnId: TranscriptTurnId } | { turnId: TranscriptTurnId; receipt: string },
  digest: unknown
) {
  return "receipt" in input && digest === (yield* receiptHash(input.receipt))
    ? channelReply(channelStatus.ok)({ status: "completed" })
    : channelReply(channelStatus.unauthenticated)({ status: "unauthenticated" });
});

const expiredReply = (
  input: { turnId: TranscriptTurnId } | { turnId: TranscriptTurnId; receipt: string }
): Response =>
  "receipt" in input
    ? channelReply(channelStatus.unauthenticated)({ status: "unauthenticated" })
    : channelReply(channelStatus.unavailable)({ status: "interrupted" });

export const observeTurn = Effect.fn(function* (
  actor: { id: string; userId: string },
  input: { turnId: TranscriptTurnId } | { turnId: TranscriptTurnId; receipt: string },
  now: number
) {
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT state,answer,receipt_digest,receipt_value,session_id,deadline_ms,proposal_iteration FROM hosted_turns WHERE id=${input.turnId} AND user_id=${actor.userId} AND browser_id=${actor.id}`;

  if (row === undefined) {
    return channelReply(channelStatus.unauthenticated)({ status: "unauthenticated" });
  }

  if (row.state === "completed") return yield* completedReceipt(input, row.receipt_digest);

  if (Number(row.deadline_ms) <= now) {
    yield* finishTurn({ turnId: input.turnId, user: actor.userId }, "interrupted", now);

    return expiredReply(input);
  }

  if (["queued", "running"].includes(String(row.state))) {
    return channelReply(channelStatus.accepted)({ status: "processing", turnId: input.turnId });
  }

  if (row.state !== "proposed") {
    return channelReply(channelStatus.unavailable)({ status: "interrupted" });
  }

  const answer = yield* Schema.decodeUnknownEffect(TranscriptText)(row.answer);

  if ("receipt" in input) {
    const digest = yield* receiptHash(input.receipt);

    const [held] =
      yield* sql`UPDATE hosted_turns SET state='completed',terminal_ms=${now},receipt_value=NULL WHERE id=${input.turnId} AND receipt_digest=${digest} AND state='proposed' RETURNING session_id`;

    if (held === undefined) {
      return channelReply(channelStatus.unauthenticated)({ status: "unauthenticated" });
    }

    const session = yield* Schema.decodeUnknownEffect(HostedAgentSessionId)(held.session_id);
    yield* appendEntry(
      session,
      Entry.AssistantTranscriptEntry({
        ...entryIdentity(input.turnId)(now),
        text: answer,
        iteration: yield* Schema.decodeUnknownEffect(AgentIteration)(row.proposal_iteration),
      })
    );
    yield* sql`UPDATE hosted_agent_sessions SET active_ms=${now} WHERE id=${session}`;
    yield* (yield* HostedPauseNotice).acknowledge(input.turnId);

    return channelReply(channelStatus.ok)({ status: "completed" });
  }

  const receipt = Option.getOrElse(
    Schema.decodeUnknownOption(Schema.String)(row.receipt_value),
    () => Hex.encode(crypto.getRandomValues(new Uint8Array(receiptBytes)))
  );

  yield* sql`UPDATE hosted_turns SET receipt_digest=${yield* receiptHash(receipt)},receipt_value=${receipt} WHERE id=${input.turnId} AND state='proposed'`;
  const challenge = yield* visibleChallenge(input.turnId, now);

  return channelReply(channelStatus.accepted)({
    turnId: input.turnId,
    text: answer,
    receipt,
    ...Option.match(challenge, {
      onNone: () => ({}),
      onSome: ({ command }) => ({ confirmation: { command } }),
    }),
  });
});

export const propose = Effect.fn(function* (
  turn: LocalTurn,
  text: TranscriptText,
  iteration: number
) {
  const current = yield* Clock.currentTimeMillis;
  yield* liveTurn(turn, current);
  const sql = yield* SqliteClient;
  const answer = yield* (yield* HostedPauseNotice).include(turn.id, text);
  const until = current + deliveryAcknowledgmentWindowMs;

  if (Option.isNone(turn.browser_id)) {
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(answer);
    yield* sql`UPDATE hosted_whatsapp_inbound SET offer_ms=${current},answer_digest=${yield* receiptHash(encoded)} WHERE user_id=${turn.user_id} AND turn_id=${turn.id}`;
  }

  yield* sql`UPDATE hosted_turns SET state='proposed',answer=${answer},deadline_ms=${until},proposal_iteration=${iteration} WHERE id=${turn.id} AND state='running'`;

  return Option.isNone(turn.browser_id) ? current : until;
});
