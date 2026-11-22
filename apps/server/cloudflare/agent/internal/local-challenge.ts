import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Option, Schema } from "effect";
import { Hex } from "effect/encoding";
import { CanonicalToolEvidence, TranscriptText } from "../../../src/core/agent/contract";
import { CanonicalOperationId } from "../../../src/core/canonical-operations/contract";
import type { LocalReviewFacts } from "../../canonical-admission/contract";
import type { HostedTextToolCall } from "../../../src/shell/hosted-inference/contract";
import { type LocalTurn } from "./local-turn";

const nonceBytes = 32,
  lifetimeMs = 600000;

const challenge = Schema.Struct({
  operation: CanonicalOperationId,
  input_json: Schema.fromJsonString(CanonicalToolEvidence),
  effect: Schema.String,
  revision: Schema.String,
  command: Schema.String,
});

export const stageChallenge = Effect.fn(function* (
  turn: LocalTurn,
  tool: HostedTextToolCall,
  facts: LocalReviewFacts
) {
  const sql = yield* SqliteClient,
    now = yield* Clock.currentTimeMillis;

  const command = "CONFIRMAR " + Hex.encode(crypto.getRandomValues(new Uint8Array(nonceBytes)));

  const input = yield* Schema.encodeEffect(Schema.fromJsonString(CanonicalToolEvidence))(
    yield* Schema.decodeUnknownEffect(CanonicalToolEvidence)(tool.params)
  );

  yield* sql`INSERT INTO hosted_confirmations(issued_turn,operation,input_json,command,effect,revision,expires_ms) VALUES(${turn.id},${tool.operation},${input},${command},${facts.effect},${facts.revision},${now + lifetimeMs}) ON CONFLICT(issued_turn) DO NOTHING`;
});

export const visibleChallenge = Effect.fn(function* (turnId: string, now: number) {
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT effect,command FROM hosted_confirmations WHERE issued_turn=${turnId} AND expires_ms>${now} AND consumed_turn IS NULL`;

  return Option.flatMap(
    Option.fromUndefinedOr(row),
    Schema.decodeUnknownOption(Schema.Struct({ effect: TranscriptText, command: Schema.String }))
  );
});

export const takeChallenge = Effect.fn(function* (turn: LocalTurn) {
  const sql = yield* SqliteClient,
    now = yield* Clock.currentTimeMillis;

  const [prior] =
    yield* sql`SELECT c.* FROM hosted_confirmations c JOIN hosted_turns t ON t.id=c.issued_turn JOIN hosted_turns active ON active.id=${turn.id} AND active.user_id=t.user_id AND active.session_id=t.session_id AND active.browser_id IS t.browser_id
  WHERE t.user_id=${turn.user_id} AND t.state='completed' AND active.state='running' AND c.expires_ms>${now}
  AND (t.browser_id IS NOT NULL OR EXISTS(SELECT 1 FROM hosted_whatsapp_inbound i JOIN hosted_whatsapp_inbound a ON a.turn_id=active.id AND a.user_id=i.user_id AND a.bsuid=i.bsuid AND a.portfolio=i.portfolio AND a.endpoint=i.endpoint WHERE i.turn_id=t.id))
  ORDER BY t.start_ms DESC,t.rowid DESC LIMIT 1`;

  if (prior === undefined || prior.consumed_turn !== null || prior.command !== turn.request_text) {
    return Option.none();
  }

  const held = yield* Schema.decodeUnknownEffect(challenge)(prior);
  yield* sql`UPDATE hosted_confirmations SET consumed_turn=${turn.id} WHERE command=${held.command} AND consumed_turn IS NULL`;

  return Option.some(held);
});
