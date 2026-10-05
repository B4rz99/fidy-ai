import { Effect, Schema } from "effect";
import { operationCatalog } from "../../../src/shell/api";
import {
  type SuggestedOperationCaller,
  canCallOperation,
  checkpointResponseSuggestions,
} from "../../../src/shell/canonical-operations/operations";
import { NextOperations } from "../../../src/shell/public-http/contract";

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
