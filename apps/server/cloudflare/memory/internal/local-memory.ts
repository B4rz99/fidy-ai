import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { DateTime, Effect, Schema } from "effect";
import {
  Memory,
  MemoryId,
  type MemoryText,
  maximumAggregateMemoryTokens,
} from "../../../src/core/memory/contract";
import type { UserId } from "../../../src/core/identity/contract";
import { type LocalMutationResult } from "../../canonical-admission/contract";
import { prepareLocalWrite } from "../../canonical-admission/operations";
import { newId } from "../../secret-material/operations";
import { memoriesFromRows } from "./storage";

const quote = Schema.encodeSync(Schema.fromJsonString(Schema.String));

const MemoryJson = Schema.toCodecJson(Memory);

const absent: LocalMutationResult = {
  status: 404,
  outcome: "not_found",
  body: {
    error: { code: "not_found", message: "No current Memory with that identifier belongs to you." },
    next: [],
  },
};

const full: LocalMutationResult = {
  status: 409,
  outcome: "resource_limit",
  body: {
    error: {
      code: "quota_exhausted",
      message: "Saving this text would exceed the User's current Memory capacity.",
    },
    next: [],
  },
};

const writeStatus = { remember: 201, revise: 200 } as const;

const success = (data: Schema.Json): LocalMutationResult => ({
  status: 200,
  outcome: "success",
  body: { data, next: [] },
});

const currentMemories = Effect.fn(function* (user: UserId) {
  const sql = yield* SqliteClient;

  const rows =
    yield* sql`SELECT id,text,created_at_ms,updated_at_ms FROM memories WHERE user_id=${user} ORDER BY created_at_ms,id`;

  return yield* Effect.fromOption(memoriesFromRows(rows));
});

type Edit =
  | { kind: "remember"; text: MemoryText }
  | { kind: "revise"; id: MemoryId; text: MemoryText }
  | { kind: "forget"; id: MemoryId };

export const prepareMemory = Effect.fn(function* (edit: Edit, user: UserId, current: number) {
  const sql = yield* SqliteClient;
  const before = yield* currentMemories(user);
  const id = edit.kind === "remember" ? MemoryId.make(newId()) : edit.id;
  const previous = before.find((item) => item.id === id);

  if (edit.kind !== "remember" && previous === undefined) return absent;

  const review = Effect.gen(function* () {
    const snapshot = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(MemoryJson)))(
      before
    );

    const original = previous === undefined ? "ausente" : quote(previous.text);

    return {
      revision: snapshot,
      effect:
        edit.kind === "forget"
          ? `Eliminar definitivamente la memoria ${id}: ${original}.`
          : `Reemplazar la memoria ${id}: ${original} por ${quote(edit.text)}.`,
    };
  });

  return prepareLocalWrite({
    targets: [`memory:${id}`],
    review,
    commit: Effect.gen(function* () {
      if (edit.kind === "forget") {
        const removed =
          yield* sql`DELETE FROM memories WHERE user_id=${user} AND id=${id} RETURNING id`;

        return removed.length === 1 ? success(id) : absent;
      }

      const [size] =
        yield* sql`SELECT COALESCE(SUM(length(CAST(json_object('id',id,'text',text) AS BLOB)) + 1),0)
        + length(CAST(json_object('id',${id},'text',${edit.text}) AS BLOB)) AS bytes
        FROM memories WHERE user_id=${user} AND id<>${id}`;

      if (
        (yield* Schema.decodeUnknownEffect(Schema.Struct({ bytes: Schema.Int }))(size)).bytes >
        maximumAggregateMemoryTokens
      ) {
        return full;
      }

      const now = DateTime.makeUnsafe(current);

      const memory = Memory.make({
        id,
        text: edit.text,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      });

      if (edit.kind === "remember") {
        yield* sql`INSERT INTO memories(id,user_id,text,created_at_ms,updated_at_ms) VALUES(${id},${user},${edit.text},${current},${current})`;
      } else {
        const changed =
          yield* sql`UPDATE memories SET text=${edit.text},updated_at_ms=${current} WHERE user_id=${user} AND id=${id} RETURNING id`;

        if (changed.length !== 1) return absent;
      }

      return {
        ...success(yield* Schema.encodeEffect(MemoryJson)(memory)),
        status: writeStatus[edit.kind],
      };
    }),
  });
});

export const readMemories = Effect.fn(function* (user: UserId) {
  const memories = yield* currentMemories(user);

  return success([...(yield* Schema.encodeEffect(Schema.Array(MemoryJson))(memories))]);
});
