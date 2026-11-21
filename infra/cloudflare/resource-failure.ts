import { Cause, Data, Effect, Option, Predicate, Schema } from "effect";
import { HttpClientError } from "effect/http";
import { isFixturePlanRefused } from "./native-fixture-plan";
import { isRecoveryPinUnavailable } from "./native-recovery-identity";

const maximumRefusalReasons = 16;

const providerRefusalTag = Schema.Literals([
  "Forbidden",
  "Unauthorized",
  "BadRequest",
  "Conflict",
  "NotFound",
  "UnprocessableEntity",
  "TooManyRequests",
  "InternalServerError",
  "BadGateway",
  "ServiceUnavailable",
  "GatewayTimeout",
  "ConfigError",
  "InvalidRoute",
  "UnknownCloudflareError",
  "CloudflareHttpError",
  "CloudflareParseError",
  "UnownedResource",
  "OwnedBySomeoneElse",
  "UnsatisfiedResourceCycle",
  "StateStoreError",
  "AuthError",
  "CredentialsRequired",
  "NeedsReauth",
  "InvalidReferenceError",
  "WorkerIdNotFound",
  "MissingProviderError",
  "WorkerVersionConfigError",
  "WorkerNotFound",
  "WorkerVersionNotFound",
  "WorkerPreviewConfigError",
  "WorkerDomainConfigError",
]);

const providerRefusalCode = Schema.optional(
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 999999 }))
);

const ProviderRefusal = providerRefusalTag.mapMembers((members) =>
  members.map((member) => Schema.TaggedStruct(member.literal, { code: providerRefusalCode }))
);

const ExceptionName = Schema.Union([
  providerRefusalTag,
  Schema.Literals([
    "SchemaError",
    "HttpClientError",
    "UnknownError",
    "TypeError",
    "RangeError",
    "MigrationError",
  ]),
]);

const exceptionCategory = (error: unknown, failure: boolean): string => {
  if (Schema.isSchemaError(error)) return "SchemaError";

  if (HttpClientError.isHttpClientError(error)) return "HttpClientError";

  if (Cause.isUnknownError(error)) return "UnknownError";

  if (Schema.is(Schema.instanceOf(TypeError))(error)) return "TypeError";

  if (Schema.is(Schema.instanceOf(RangeError))(error)) return "RangeError";

  if (Predicate.isError(error)) {
    return Option.getOrElse(Schema.decodeUnknownOption(ExceptionName)(error.name), () => "Error");
  }

  return failure ? "UnclassifiedFailure" : "UnclassifiedDefect";
};

const StateRefusal = Schema.TaggedStruct("StateStoreError", {
  http: Schema.Struct({
    status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
  }),
});

const refusalCategory = (error: unknown, failure: boolean): string => {
  if (isFixturePlanRefused(error)) return "closed fixture " + error.reason;

  if (isRecoveryPinUnavailable(error)) return "account recovery PIN " + error.reason;
  const state = Schema.decodeUnknownOption(StateRefusal)(error);

  if (Option.isSome(state)) return "StateStoreError; HTTP " + state.value.http.status;
  const refusal = Schema.decodeUnknownOption(ProviderRefusal)(error);

  if (Option.isNone(refusal)) return exceptionCategory(error, failure);
  const { _tag, code } = refusal.value;

  return code === undefined ? _tag : `${_tag}; code=${code}`;
};

const failureCategories = (value: unknown, failure: boolean): ReadonlyArray<string> => {
  const details: string[] = [];
  let error = value;

  for (let depth = 0; depth < 4; depth++) {
    const category = refusalCategory(error, failure);

    if (depth === 0 || !category.startsWith("Unclassified")) details.push(category);

    if (!Predicate.isError(error) || error.cause === undefined) break;
    error = error.cause;
  }

  return details;
};

export const resourceFailureMessage = (cause: Cause.Cause<unknown>): string => {
  const details = new Set<string>();

  for (const reason of cause.reasons.slice(0, maximumRefusalReasons)) {
    if (Cause.isInterruptReason(reason)) continue;
    const error = Cause.isFailReason(reason) ? reason.error : reason.defect;

    for (const category of failureCategories(error, Cause.isFailReason(reason))) {
      details.add(category);
    }
  }

  const suffix = details.size === 0 ? "" : ` (${[...details].join(", ")})`;

  return `Alchemy resource operation failed${suffix}; inspect release state.`;
};

type NativeStage =
  | "planning"
  | "Worker bindings"
  | "resource inventory"
  | "first-install ownership"
  | "account recovery PIN"
  | "Access host plan"
  | "closed edge preparation"
  | "upload verification"
  | "host capture"
  | "Site plan verification"
  | "provider apply";

class NativeStageFailure extends Data.TaggedError("NativeStageFailure")<{ message: string }> {}

const isNativeStageFailure = (value: unknown): value is NativeStageFailure =>
  Predicate.isTagged(value, "NativeStageFailure");

export type { NativeStageFailure };

export const nativeResourceStage =
  (
    stage:
      | NativeStage
      | {
          stage: "planning" | "closed edge preparation" | "provider apply";
          details: () => string;
        }
  ) =>
  <A, E, R>(operation: Effect.Effect<A, E, R>): Effect.Effect<A, E | NativeStageFailure, R> =>
    operation.pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.fail(
            new NativeStageFailure({
              message: `Native release failed during ${Predicate.isString(stage) ? stage : stage.stage}. ${resourceFailureMessage(cause)}${Predicate.isString(stage) ? "" : stage.details()}`,
            })
          )
      )
    );

export const nativeResourceFailureMessage = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.findErrorOption(cause);

  return Option.isSome(failure) && isNativeStageFailure(failure.value)
    ? failure.value.message
    : `Native release failed during configuration. ${resourceFailureMessage(cause)}`;
};

export const nativePlanningFailure = (cause: Cause.Cause<unknown>): NativeStageFailure =>
  new NativeStageFailure({ message: nativeResourceFailureMessage(cause) });
