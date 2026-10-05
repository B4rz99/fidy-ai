import { Effect, Schema } from "effect";
import type { OAuthCaller } from "../../../src/shell/oauth-agents/contract";
import type { CanonicalOperationId } from "../../../src/core/canonical-operations/contract";
import type { CanonicalRefusalDisposition } from "../../canonical-work/contract";
import { recordOAuthCall } from "../../../src/shell/audit/operations";
import { liveOAuthAuthority } from "../../../src/shell/oauth-agents/operations";
import { prepareOwnedStatement } from "../../database/operations";
import { newId } from "../../secret-material/operations";
import { operationCatalog } from "../../../src/shell/api";
import {
  type SuggestedOperationCaller,
  canCallOperation,
  checkpointResponseSuggestions,
} from "../../../src/shell/canonical-operations/operations";
import { NextOperations } from "../../../src/shell/public-http/contract";

/** Record metadata-only refusal evidence under the exact admitted OAuth child or envelope authority. */
export const recordOAuthRefusal = (
  input: Readonly<{
    db: D1Database;
    subject: OAuthCaller;
    current: number;
    operation: CanonicalOperationId;
  }>
): Effect.Effect<CanonicalRefusalDisposition> =>
  Effect.tryPromise(() =>
    prepareOwnedStatement({
      db: input.db,
      statement: recordOAuthCall({
        authority: liveOAuthAuthority(input),
        id: newId(),
        current: input.current,
        operation: input.operation,
        outcome: "rejected",
      }),
    }).run()
  ).pipe(
    Effect.map((recorded): CanonicalRefusalDisposition =>
      recorded.meta.changes === 1 ? "recorded" : "credential_refused"
    ),
    Effect.orElseSucceed(() => "unavailable" as const)
  );

const Success = Schema.Struct({ data: Schema.Json, next: NextOperations });
const Failure = Schema.Struct({ error: Schema.Json, next: NextOperations });
/** Retain the canonical envelope while checkpointing continuations against current OAuth capability and tier facts. */
export const checkpointOAuthResponse = (
  input: Readonly<{ response: Response; caller: SuggestedOperationCaller }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const raw: unknown = yield* Effect.tryPromise(() => input.response.json());
    const schema = input.response.ok ? Success : Failure;
    const value = yield* Schema.decodeUnknownEffect(schema)(raw);
    const canonical = yield* Schema.encodeUnknownEffect(schema)(value);
    const canonicalJson = yield* Schema.decodeUnknownEffect(Schema.Json)(canonical);
    const encoded = checkpointResponseSuggestions({
      value: canonicalJson,
      catalog: operationCatalog,
      available: (operation) => canCallOperation(operation.policy, input.caller),
    });
    return Response.json(encoded, {
      status: input.response.status,
      headers: {
        "cache-control": "no-store",
        ...(input.response.headers.has("retry-after")
          ? { "retry-after": input.response.headers.get("retry-after") ?? "" }
          : {}),
      },
    });
  }).pipe(
    Effect.orElseSucceed(() =>
      Response.json(
        { error: { code: "unavailable", message: "Canonical operation unavailable." }, next: [] },
        { status: 503, headers: { "cache-control": "no-store" } }
      )
    )
  );
