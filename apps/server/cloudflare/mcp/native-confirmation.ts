import { type Cause, Clock, Data, Effect, Option, Schema, type Scope } from "effect";
import { McpProtocol, McpSchema } from "effect/ai";
import { OAuthConfirmationAttempt } from "../../src/shell/mcp/contract";
import { OAuthNativeReview } from "../oauth-confirmation/contract";
import { readBoundedRequestBody } from "../http/operations";
import type { RequestBodyPolicy } from "../http/contract";

const [ReviewAttempt, DecisionAttempt] = OAuthConfirmationAttempt.members;

const DecisionFields = Schema.Struct({
  reference: DecisionAttempt.fields.reference,
  response: DecisionAttempt.fields.response,
});

export type NativeConfirmationRead = Data.TaggedEnum<{
  Invalid: {};
  Valid: { readonly attempt: Option.Option<OAuthConfirmationAttempt> };
}>;

export const NativeConfirmationRead = Data.taggedEnum<NativeConfirmationRead>();

export const readNativeConfirmation = (
  input: Readonly<{
    context: McpSchema.McpRequestContext["Service"];
    supplied: Option.Option<OAuthConfirmationAttempt>;
  }>
): NativeConfirmationRead => {
  if (Option.isSome(input.supplied)) {
    return NativeConfirmationRead.Valid({ attempt: input.supplied });
  }

  const context = input.context;

  if (context.requestState !== undefined) {
    const attempt = Schema.decodeUnknownOption(DecisionFields)({
      reference: context.requestState,
      response: context.inputResponses?.review ?? null,
    }).pipe(Option.map((fields) => DecisionAttempt.make(fields)));

    return Option.isNone(attempt)
      ? NativeConfirmationRead.Invalid()
      : NativeConfirmationRead.Valid({ attempt });
  }

  return NativeConfirmationRead.Valid({
    attempt:
      context.clientCapabilities.elicitation?.form === undefined
        ? Option.none()
        : Option.some(ReviewAttempt.make({})),
  });
};

export type NativeConfirmation = Data.TaggedEnum<{
  InputRequired: { readonly result: McpSchema.InputRequired };
  Unavailable: {};
  Decision: { readonly attempt: OAuthConfirmationAttempt };
}>;

export const NativeConfirmation = Data.taggedEnum<NativeConfirmation>();

type NativeConfirmationFailure =
  | Effect.Error<ReturnType<typeof readBoundedRequestBody>>
  | Schema.SchemaError
  | Effect.Error<ReturnType<McpSchema.McpReverseClient["elicit"]>>
  | Cause.TimeoutError;

export const requestNativeConfirmation = (
  input: Readonly<{
    response: Response;
    context: McpSchema.McpRequestContext["Service"];
    responsePolicy: RequestBodyPolicy;
  }>
): Effect.Effect<NativeConfirmation, NativeConfirmationFailure, Scope.Scope> =>
  Effect.gen(function* () {
    const bytes = yield* readBoundedRequestBody(
      new Request("https://coordinator.internal/review", {
        method: "POST",
        body: input.response.body,
      }),
      input.responsePolicy
    );

    const review = yield* Schema.decodeEffect(Schema.fromJsonString(OAuthNativeReview))(
      new TextDecoder().decode(bytes)
    );

    const params = McpSchema.ElicitRequestFormParams.make({
      mode: "form",
      message: review.message,
      requestedSchema: {
        type: "object",
        properties: { confirm: { type: "boolean", title: "Confirmar la acción", default: false } },
        required: ["confirm"],
      },
    });

    if (input.context.protocolVersion === McpProtocol.v2026_07_28.protocolVersion) {
      return NativeConfirmation.InputRequired({
        result: new McpSchema.InputRequired({
          requestState: review.reference,
          inputRequests: {
            review: {
              method: "elicitation/create",
              params: yield* Schema.encodeEffect(McpSchema.ElicitRequestFormParams)(params),
            },
          },
        }),
      });
    }

    const legacy = yield* Effect.serviceOption(McpSchema.McpServerClient);

    if (Option.isNone(legacy)) return NativeConfirmation.Unavailable();
    const client = yield* legacy.value.getClient;
    const remaining = Math.max(1, review.expiresAtMilliseconds - (yield* Clock.currentTimeMillis));
    const decision = yield* client.elicit(params).pipe(Effect.timeout(remaining));

    return NativeConfirmation.Decision({
      attempt: DecisionAttempt.make({
        reference: review.reference,
        response: yield* Schema.encodeEffect(McpSchema.ElicitResult)(decision),
      }),
    });
  });
