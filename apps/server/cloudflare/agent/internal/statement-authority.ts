import { type Cause, Effect, Option, Schema } from "effect";
import {
  CanonicalToolEvidence,
  HostedAgentSessionId,
  type TranscriptTurnId,
} from "../../../src/core/agent/contract";
import { hostedSessionIdleMilliseconds } from "../../../src/core/agent/operations";
import type { HostedCanonicalCaller } from "../../canonical-work/contract";
import type { WhatsAppHostedSubject } from "../../whatsapp/contract";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";

type Approval = Option.Option<Readonly<{ operation: string; input: CanonicalToolEvidence }>>;
const confirmationGuard = ({
  approval,
  userId,
  originTurns,
}: Readonly<{ approval: Approval; userId: string; originTurns: OwnedStatement }>): Effect.Effect<
  OwnedStatement,
  Schema.SchemaError
> =>
  Effect.gen(function* () {
    if (Option.isNone(approval)) return { sql: "1 = 1", params: [] };
    const input = yield* Schema.encodeEffect(Schema.fromJsonString(CanonicalToolEvidence))(
      approval.value.input
    );
    return {
      sql: `EXISTS (SELECT 1 FROM hosted_confirmations c JOIN hosted_turns prior ON prior.id = c.issued_turn_id
      WHERE c.user_id = ? AND c.consumed_turn_id = hosted_turns.id AND c.operation = ? AND c.input_json = ?
        AND c.consumed_at_ms < c.expires_at_ms AND prior.status = 'completed' AND prior.hosted_session_id = hosted_turns.hosted_session_id AND c.issued_turn_id IN (${originTurns.sql}))`,
      params: [userId, approval.value.operation, input, ...originTurns.params],
    };
  });

const readSession = ({
  db,
  authority,
}: Readonly<{ db: D1Database; authority: HostedCanonicalCaller["authority"] }>): Effect.Effect<
  unknown,
  Cause.UnknownError
> =>
  Effect.tryPromise(() =>
    db
      .prepare(`SELECT hosted_session_id FROM hosted_turns WHERE ${authority.predicate}`)
      .bind(...authority.bindings)
      .first()
  );

const publicationOrigin = ({
  authority,
  current,
}: Readonly<{
  authority: HostedCanonicalCaller["authority"];
  current: number;
}>): OwnedStatement => ({
  sql: `SELECT id AS turn_id,user_id,hosted_session_id AS session_id,? AS expires_at_ms FROM hosted_turns WHERE ${authority.predicate}`,
  params: [current + hostedSessionIdleMilliseconds, ...authority.bindings],
});

type StatementCallerInput = Readonly<{
  db: D1Database;
  subject: WhatsAppHostedSubject;
  turnId: TranscriptTurnId;
  current: number;
  live: OwnedStatement;
  approval: Approval;
}>;

/** Mint statement authority only for this verified channel identity's admitted Pending Turn.
 * The live guard remains in every owner write; the readback is routing, never its authorization.
 */
export const mintHostedStatementCaller = ({
  db,
  subject,
  turnId,
  current,
  approval,
  live,
}: StatementCallerInput): Effect.Effect<Option.Option<HostedCanonicalCaller>> =>
  Effect.gen(function* () {
    const authorizedOperation = Option.map(approval, ({ operation }) => operation);
    const originTurns = {
      sql: `SELECT original.turn_id FROM hosted_whatsapp_inbound original JOIN hosted_whatsapp_inbound active
      ON active.turn_id = ? AND active.user_id = ? WHERE original.user_id = ?
      AND original.portfolio_id = active.portfolio_id AND original.bsuid = active.bsuid
      AND original.business_phone_number_id = active.business_phone_number_id`,
      params: [turnId, subject.userId, subject.userId],
    };
    const confirmation = yield* confirmationGuard({
      approval,
      userId: subject.userId,
      originTurns,
    });
    const authority: HostedCanonicalCaller["authority"] = {
      table: "hosted_turns",
      predicate: `id = ? AND user_id = ? AND status = 'pending' AND EXISTS (${live.sql})
      AND EXISTS (SELECT 1 FROM hosted_whatsapp_inbound i WHERE i.turn_id = hosted_turns.id
        AND i.user_id = ? AND i.portfolio_id = ? AND i.bsuid = ?)
      AND EXISTS (SELECT 1 FROM hosted_agent_sessions s WHERE s.id = hosted_turns.hosted_session_id
        AND s.user_id = ? AND s.status = 'active' AND
        max(coalesce(s.last_activity_at_ms,s.started_at_ms),hosted_turns.started_at_ms) > ?) AND (${confirmation.sql})`,
      bindings: [
        turnId,
        subject.userId,
        ...live.params,
        subject.userId,
        subject.portfolioId,
        subject.bsuid,
        subject.userId,
        current - hostedSessionIdleMilliseconds,
        ...confirmation.params,
      ],
    };
    return yield* readSession({ db, authority }).pipe(
      Effect.map(
        Schema.decodeUnknownOption(Schema.Struct({ hosted_session_id: HostedAgentSessionId }))
      ),
      Effect.map((row) =>
        Option.map(row, ({ hosted_session_id }): HostedCanonicalCaller => ({
          _tag: "HostedCanonical",
          userId: subject.userId,
          turnId,
          sessionId: hosted_session_id,
          authorizedOperation,
          originTurns,
          publicationOrigin: publicationOrigin({ authority, current }),
          authority,
        }))
      )
    );
  }).pipe(Effect.orElseSucceed(() => Option.none()));
