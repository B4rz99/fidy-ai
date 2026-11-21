import { Clock, Effect, Option, Schema } from "effect";
import { getBoundOperationCatalog } from "../../../src/shell/canonical-catalog/contract";
import type { OAuthCanonicalAdmission } from "../../../src/shell/mcp/contract";
import type { OAuthCaller } from "../../../src/shell/oauth-agents/contract";
import { CanonicalRetryKey } from "../../../src/core/quotas/contract";
import { invalidRequest } from "./bootstrap";

const scalar = Schema.Union([Schema.Finite, Schema.Boolean, Schema.String]);

const wire = Schema.Struct({
  params: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  query: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.NullOr(Schema.Union([scalar, Schema.Array(scalar)])))
  ),
  payload: Schema.optionalKey(Schema.Json),
});

const operationUrl = (route: string, encoded: typeof wire.Type): URL => {
  const path = route
    .split("/")
    .map((part) =>
      part.startsWith(":") ? encodeURIComponent(encoded.params?.[part.slice(1)] ?? "") : part
    )
    .join("/");

  const url = new URL(path, "https://user.invalid");

  for (const [key, values] of Object.entries(encoded.query ?? {})) {
    if (values === null) continue;

    for (const value of Array.isArray(values) ? values : [values]) {
      url.searchParams.append(key, String(value));
    }
  }

  return url;
};

export const canonicalLocalRequest = Effect.fn(
  function* (admission: OAuthCanonicalAdmission, signal: AbortSignal) {
    const operation = getBoundOperationCatalog().byId.get(admission.operation);

    if (
      operation === undefined ||
      admission.deadlineMilliseconds <= (yield* Clock.currentTimeMillis) ||
      signal.aborted
    ) {
      return invalidRequest();
    }

    const decoded = yield* Schema.decodeEffect(operation.input, {
      onExcessProperty: "error",
    })(admission.input);

    const encoded = yield* Schema.decodeUnknownEffect(wire)(
      yield* Schema.encodeEffect(operation.httpInput)(decoded)
    );

    const url = operationUrl(operation.route, encoded);
    const headers = new Headers({ "content-type": "application/json" });

    if (admission.retryKey !== undefined) {
      if (!Schema.is(CanonicalRetryKey)(admission.retryKey)) return invalidRequest();
      headers.set("Fidy-Retry-Key", admission.retryKey);
    }

    const body =
      encoded.payload === undefined
        ? undefined
        : yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(encoded.payload);

    const subject: OAuthCaller = {
      userId: admission.userId,
      oauthConnectionId: admission.connectionId,
      credentialId: admission.credentialId,
      clientId: admission.clientId,
      resource: admission.resource,
      digest: new Uint8Array(admission.digest),
      requiredScope: Option.none(),
    };

    return {
      operation,
      request: new Request(
        url.href,
        body === undefined
          ? { method: operation.method, headers, signal }
          : { method: operation.method, headers, signal, body }
      ),
      oauth: { subject, admission },
    };
  },
  Effect.tapCause(Effect.logDebug),
  Effect.catchCause(() => Effect.succeed(invalidRequest()))
);
