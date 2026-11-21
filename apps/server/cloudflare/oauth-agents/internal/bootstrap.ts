import { type BootstrapUnavailable } from "../contract";
import { Data, Effect, Option, Schema } from "effect";
import { OAuthRegistration } from "../../../src/shell/oauth-agents/contract";
import { PATScopes } from "../../../src/core/tokens/contract";
import { RequestBodyPolicy } from "../../http/contract";
import { readBoundedRequestBody } from "../../http/operations";
import { newId } from "../../secret-material/operations";
import { oauthResponse as jsonResponse } from "./response";

const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 16384,
  deadlineMilliseconds: 3000,
});

export const attemptLifetimeMs = 600_000;

const millisecondsPerSecond = 1000;

const registrationStatus = 201;

const invalidStatus = 400;

export const invalidRequest = (): Response =>
  jsonResponse({ body: { error: "invalid_request" }, status: invalidStatus });

export const isResponse = Schema.is(Schema.instanceOf(Response));

export class BootstrapInvalid extends Data.TaggedError("BootstrapInvalid")<{
  readonly cause: Option.Option<unknown>;
}> {}

export const decodePayload = <Payload extends Schema.ConstraintDecoder<unknown>>(
  input: Readonly<{ request: Request; schema: Payload; onExcessProperty: "ignore" | "error" }>
): Effect.Effect<Payload["Type"], BootstrapInvalid> =>
  Effect.gen(function* () {
    if (
      input.request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json"
    ) {
      return yield* Effect.fail(undefined);
    }

    const bytes = yield* readBoundedRequestBody(input.request, policy);

    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: () => undefined,
    });

    return yield* Schema.decodeEffect(Schema.fromJsonString(input.schema), {
      onExcessProperty: input.onExcessProperty,
    })(text);
  }).pipe(
    Effect.catchCause((cause) => Effect.fail(new BootstrapInvalid({ cause: Option.some(cause) })))
  );

export const registerWithStore = Effect.fn(
  function* <R>(input: {
    request: Request;
    current: number;
    persist: (id: string, encoded: string) => Effect.Effect<void, BootstrapUnavailable, R>;
  }) {
    const metadata = yield* decodePayload({
      request: input.request,
      schema: OAuthRegistration,
      onExcessProperty: "ignore",
    });

    if (
      metadata.grant_types !== undefined &&
      !metadata.grant_types.includes("authorization_code")
    ) {
      return jsonResponse({ body: { error: "invalid_client_metadata" }, status: invalidStatus });
    }

    const id = newId();
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(OAuthRegistration))(metadata);
    yield* input.persist(id, encoded);

    return jsonResponse({
      body: {
        client_id: id,
        client_id_issued_at: Math.floor(input.current / millisecondsPerSecond),
        ...metadata,
        grant_types: metadata.grant_types ?? ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      status: registrationStatus,
    });
  },
  Effect.catchTags({
    BootstrapInvalid: () =>
      Effect.succeed(
        jsonResponse({ body: { error: "invalid_client_metadata" }, status: invalidStatus })
      ),
    SchemaError: () =>
      Effect.succeed(
        jsonResponse({ body: { error: "invalid_client_metadata" }, status: invalidStatus })
      ),
  })
);

export const registeredRedirect = ({
  registered,
  requested,
}: {
  registered: string;
  requested: string;
}): boolean => {
  if (registered === requested) return true;
  const original = new URL(registered);

  if (original.protocol !== "http:") return false;
  const callback = new URL(requested);
  callback.port = original.port;

  return callback.href === registered;
};

export const requestedScopes = (scope: Option.Option<string>): Option.Option<PATScopes> => {
  const scopes = Option.match(scope, {
    onNone: () => ["read"],
    onSome: (value) => value.split(" "),
  });

  if (new Set(scopes).size !== scopes.length) return Option.none();

  return Schema.decodeUnknownOption(PATScopes)(scopes);
};
