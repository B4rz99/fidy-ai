import { DateTime, Option, Schema } from "effect";
import { type Memory, MemoryId, MemoryText } from "../../../src/core/memory/contract";
import { MemoryGroup } from "../../../src/shell/memory/contract";
import { getOperationPolicy } from "../../../src/shell/canonical-policy/contract";
import { type TransactionCaller, isOAuthCaller } from "../../canonical-work/operations";
import { oauthMutationReview } from "../../oauth-confirmation/operations";
import type { OAuthMutationReview } from "../../oauth-confirmation/contract";

const SnapshotJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      id: MemoryId,
      text: MemoryText,
      createdAt: Schema.String,
      updatedAt: Schema.String,
    })
  )
);
const quoted = Schema.encodeSync(Schema.fromJsonString(Schema.String));

export const memoryOAuthReview = (
  input: Readonly<{
    db: D1Database;
    subject: TransactionCaller;
    memories: ReadonlyArray<Memory>;
    id: string;
  }> &
    (Readonly<{ operation: "revise"; text: string }> | Readonly<{ operation: "forget" }>)
): Option.Option<OAuthMutationReview> => {
  if (
    !isOAuthCaller(input.subject) ||
    getOperationPolicy(MemoryGroup.endpoints[input.operation]).agentConfirmation !== "required"
  ) {
    return Option.none();
  }
  const snapshot = input.memories.map((memory) => ({
    id: memory.id,
    text: memory.text,
    createdAt: DateTime.formatIso(memory.createdAt),
    updatedAt: DateTime.formatIso(memory.updatedAt),
  }));
  const previous = Option.fromUndefinedOr(snapshot.find((memory) => memory.id === input.id));
  const before = Option.match(previous, {
    onNone: () => "ausente",
    onSome: (memory) => quoted(memory.text),
  });
  const revision = Schema.encodeSync(SnapshotJson)(snapshot);
  return Option.some(
    oauthMutationReview({
      db: input.db,
      revision,
      effect:
        input.operation === "revise"
          ? `Reemplazar la memoria ${input.id}: ${before} por ${quoted(input.text)}.`
          : `Eliminar definitivamente la memoria ${input.id}: ${before}.`,
      guard: {
        sql: `SELECT 1 WHERE (SELECT count(*) FROM memories WHERE user_id = ?) = ?
          AND NOT EXISTS (SELECT 1 FROM json_each(?) AS expected WHERE NOT EXISTS (
            SELECT 1 FROM memories AS memory WHERE memory.user_id = ?
            AND memory.id = json_extract(expected.value, '$.id')
            AND memory.text = json_extract(expected.value, '$.text')
            AND memory.created_at = json_extract(expected.value, '$.createdAt')
            AND memory.updated_at = json_extract(expected.value, '$.updatedAt')))`,
        params: [input.subject.userId, snapshot.length, revision, input.subject.userId],
      },
    })
  );
};
