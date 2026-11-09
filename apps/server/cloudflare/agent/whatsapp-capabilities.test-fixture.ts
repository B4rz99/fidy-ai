import {
  publishOwnedStatement,
  stageOwnedStatement,
} from "../ingestion/statement-publication.test-fixture";
import { newId } from "../secret-material/operations";
import { WhatsAppHostedSubject } from "../whatsapp/contract";
import { expect } from "vitest";
import { CanonicalToolOutcome } from "../../src/core/agent/contract";
import { Effect, Option, Schema } from "effect";
import { UserId } from "../../src/core/identity/contract";
import { WhatsAppProviderMessageId } from "../../src/shell/channels/whatsapp/contract";
import { resumeWhatsAppTurn } from "./internal/hosted-turn";
import {
  documentStorage,
  encodeJson,
  finishLatestWhatsAppFixture,
  finishStatementExtraction,
  inference,
  makeAbortController,
  queuedWhatsAppTurnWithMessage,
  reply,
  users,
} from "./hosted-turn.test-fixture";

export const toolReply = ({
  operation,
  input,
}: Readonly<{ operation: string; input: unknown }>): Response =>
  Response.json({
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "qa-call",
              type: "function",
              function: { name: operation.replace(".", "__"), arguments: encodeJson(input) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
  });

export const exerciseTurn = Effect.fn(function* ({
  db,
  text,
  generate,
  messageId,
}: Readonly<{
  db: D1Database;
  text: string;
  generate: (request: unknown) => Promise<Response>;
  messageId: string;
}>) {
  const turnId = yield* Effect.tryPromise(() =>
    queuedWhatsAppTurnWithMessage({ db, index: 0, text, messageId })
  );
  const model = yield* Effect.tryPromise(() => inference(generate));
  const sent: Array<string> = [];
  const confirmationCommands: Array<string> = [];
  const response = yield* resumeWhatsAppTurn({
    db,
    userId: UserId.make(users[0]),
    turnId,
    bucket: Option.none(),
    outbound: { execute: () => Effect.die("Unexpected media request") },
    inference: model,
    deliver: () => ({
      _tag: "WhatsApp",
      contextualReplyQuery: Option.none(),
      send: ({
        text,
        confirmation,
      }): Effect.Effect<{ kind: "accepted"; messageId: WhatsAppProviderMessageId }> => {
        sent.push(text);
        if (Option.isSome(confirmation)) confirmationCommands.push(confirmation.value.command);
        return Effect.succeed({
          kind: "accepted",
          messageId: WhatsAppProviderMessageId.make(`${messageId}-reply`),
        });
      },
    }),
    signal: makeAbortController().signal,
    scheduleRecovery: () => Promise.resolve(),
    onAdmitted: () => {},
  });
  return { turnId, sent, response, confirmationCommands };
});

export const runCapability = Effect.fn(function* ({
  db,
  operation,
  input,
}: Readonly<{ db: D1Database; operation: string; input: unknown }>) {
  const subject = yield* Schema.decodeEffect(WhatsAppHostedSubject)({
    _tag: "WhatsAppHosted",
    userId: users[0],
    portfolioId: "portfolio-1",
    bsuid: "CO.13491208655302741910",
  });
  const identity = newId();
  let round = 0;
  const first = yield* exerciseTurn({
    db,
    text: `Prueba QA de ${operation}`,
    messageId: `wamid.qa-${operation}-${identity}`,
    generate: () =>
      Promise.resolve(
        ++round === 1 ? toolReply({ operation, input }) : reply("Consulta verificada.")
      ),
  });
  expect(first.sent, `${operation}: proposal status ${first.response.status}`).toHaveLength(1);
  const command = yield* Effect.tryPromise(() =>
    db
      .prepare("SELECT command FROM hosted_confirmations WHERE issued_turn_id=?")
      .bind(first.turnId)
      .first<string>("command")
  );
  yield* finishLatestWhatsAppFixture({ db, subject });
  let result = first;
  if (command !== null) {
    expect(first.confirmationCommands).toEqual([command]);
    expect(first.sent[0]).not.toContain(command);
    result = yield* exerciseTurn({
      db,
      text: command,
      messageId: `wamid.qa-confirm-${identity}`,
      generate: () =>
        Promise.reject(new Error("Exact confirmation must execute without inference")),
    });
    expect(result.sent, `${operation}: confirmation status ${result.response.status}`).toHaveLength(
      1
    );
    yield* finishLatestWhatsAppFixture({ db, subject });
  }
  const raw = yield* Effect.tryPromise(() =>
    db
      .prepare(
        "SELECT outcome_json FROM transcript_entries WHERE turn_id=? AND kind='tool_result' AND operation=? ORDER BY iteration DESC LIMIT 1"
      )
      .bind(result.turnId, operation)
      .first<string>("outcome_json")
  );
  expect(raw, `${operation}: retained result`).toEqual(expect.any(String));
  const outcome = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CanonicalToolOutcome))(
    raw
  );
  return { turnId: result.turnId, outcome };
});

export const successfulCapability = Effect.fn(function* (
  input: Readonly<{ db: D1Database; operation: string; input: unknown }>
) {
  const result = yield* runCapability(input);
  expect(result.outcome._tag).toBe("Succeeded");
  if (result.outcome._tag !== "Succeeded") return yield* Effect.die(result.outcome);
  if (input.operation !== "operations.executeAtomicBatch") {
    const audit = yield* Effect.tryPromise(() =>
      input.db
        .prepare("SELECT user_id FROM audit_entries WHERE hosted_turn_id=? AND operation=? LIMIT 1")
        .bind(result.turnId, input.operation)
        .first<string>("user_id")
    );
    expect(audit, `${input.operation}: attributed audit`).toBe(users[0]);
  }
  return result.outcome.output;
});

const createdStatus = 201;
const acceptedStatus = 202;

export const seedReviewItem = Effect.fn(function* (db: D1Database) {
  const { bucket } = yield* Effect.tryPromise(() => documentStorage.acquire());
  const storage = { db, bucket };
  const staged = yield* Effect.tryPromise(() =>
    stageOwnedStatement({
      storage,
      index: 0,
      request: new Request("https://owner-fixture.internal/bytes", {
        method: "POST",
        body: new TextEncoder().encode("fecha,valor,descripcion\n2026-08-01,?,Cafe QA\n"),
      }),
    })
  );
  expect(staged.status).toBe(createdStatus);
  const reference = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      data: Schema.Struct({
        stagingId: Schema.String,
        byteLength: Schema.Int,
        sha256: Schema.String,
      }),
    })
  )(yield* Effect.tryPromise(() => staged.json()));
  const published = yield* Effect.tryPromise(() =>
    publishOwnedStatement({
      storage,
      input: { index: 0, idempotencyKey: newId(), reference: reference.data },
    })
  );
  expect(published.status).toBe(acceptedStatus);
  yield* Effect.tryPromise(() => finishStatementExtraction({ db, bucket, userId: users[0] }));
  const id = yield* Effect.tryPromise(() =>
    db
      .prepare("SELECT id FROM ingestion_review_items WHERE user_id=? LIMIT 1")
      .bind(users[0])
      .first<string>("id")
  );
  return yield* Schema.decodeUnknownEffect(Schema.String)(id);
});
