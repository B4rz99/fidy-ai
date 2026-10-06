import { type Cause, Clock, Effect, Option, Schema, type Scope } from "effect";
import { McpProtocol, McpSchema } from "effect/ai";
import { OAuthConfirmationAttempt } from "../../src/shell/mcp/contract";
import { OAuthNativeReview } from "../oauth-confirmation/contract";
import { readBoundedRequestBody } from "../http/operations";
import type { RequestBodyPolicy } from "../http/contract";

/** Protocol-native continuation only: canonical arguments cannot carry a confirmation decision. */
export const readNativeConfirmation = (
  input: Readonly<{
    context: McpSchema.McpRequestContext["Service"];
    supplied: Option.Option<OAuthConfirmationAttempt>;
  }>
):
  | Readonly<{ _tag: "Invalid" }>
  | Readonly<{ _tag: "Valid"; attempt: Option.Option<OAuthConfirmationAttempt> }> => {
  if (Option.isSome(input.supplied)) return { _tag: "Valid", attempt: input.supplied };
  const context = input.context;
  if (context.requestState !== undefined) {
    const attempt = Schema.decodeOption(OAuthConfirmationAttempt)({
      _tag: "Decision",
      reference: context.requestState,
      response: context.inputResponses?.review ?? null,
    });
    return Option.isNone(attempt) ? { _tag: "Invalid" } : { _tag: "Valid", attempt };
  }
  return {
    _tag: "Valid",
    attempt:
      context.clientCapabilities.elicitation?.form === undefined
        ? Option.none()
        : Option.some({ _tag: "Review" }),
  };
};

type NativeConfirmation =
  | Readonly<{ _tag: "InputRequired"; result: McpSchema.InputRequired }>
  | Readonly<{ _tag: "Unavailable" }>
  | Readonly<{ _tag: "Decision"; attempt: OAuthConfirmationAttempt }>;
type NativeConfirmationFailure =
  | Effect.Error<ReturnType<typeof readBoundedRequestBody>>
  | Schema.SchemaError
  | Effect.Error<ReturnType<McpSchema.McpReverseClient["elicit"]>>
  | Cause.TimeoutError;

/** Modern keyed continuation or legacy server request. Neither creates additional caller authority. */
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
      return {
        _tag: "InputRequired" as const,
        result: new McpSchema.InputRequired({
          requestState: review.reference,
          inputRequests: {
            review: {
              method: "elicitation/create",
              params: yield* Schema.encodeEffect(McpSchema.ElicitRequestFormParams)(params),
            },
          },
        }),
      };
    }
    const legacy = yield* Effect.serviceOption(McpSchema.McpServerClient);
    if (Option.isNone(legacy)) return { _tag: "Unavailable" as const };
    const client = yield* legacy.value.getClient;
    const remaining = Math.max(1, review.expiresAtMilliseconds - (yield* Clock.currentTimeMillis));
    const decision = yield* client.elicit(params).pipe(Effect.timeout(remaining));
    return {
      _tag: "Decision" as const,
      attempt: OAuthConfirmationAttempt.make({
        _tag: "Decision",
        reference: review.reference,
        response: yield* Schema.encodeEffect(McpSchema.ElicitResult)(decision),
      }),
    };
  });
