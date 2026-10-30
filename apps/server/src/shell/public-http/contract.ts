import * as Arr from "effect/Array";
import { Option, Schema } from "effect";
import { HttpApiMiddleware } from "effect/http-api";
import {
  type CatalogOperation,
  getBoundOperationCatalog,
} from "~/shell/canonical-catalog/contract";
import { userOwnedAgentCapability } from "~/shell/canonical-policy/contract";
import { AllowanceKind } from "~/core/quotas/contract";

const englishSentenceSegmenter = new Intl.Segmenter("en", {
  granularity: "sentence",
});

const maximumSuggestedOperationHintLength = 140;

const SuggestedOperationHint = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(maximumSuggestedOperationHintLength),
  Schema.makeFilter((hint) =>
    /[.!?]$/u.test(hint) &&
    !/[\r\n]/u.test(hint) &&
    Array.from(englishSentenceSegmenter.segment(hint)).length === 1
      ? undefined
      : "Expected one English sentence ending in punctuation"
  )
).annotate({
  description:
    "One English sentence on why that call is worth making, no more than 140 characters. " +
    "Addressed to you, the calling agent, and not to the user — act on it rather than reading it out.",
});

/**
 * The internal carrier for reflected schema members. Handler proposals never
 * use this broad shape: `suggestOperation` binds each operation id to its input
 * at compile time, and this reflected union strictly decodes the same pairing
 * at the untyped response boundary without introducing an API assembly cycle.
 */
type SuggestedOperationValue =
  | { readonly tool: string; readonly hint: string }
  | {
      readonly tool: string;
      readonly args: Option.Option<unknown>;
      readonly hint: string;
    };

const suggestedOperationMember = (
  operation: CatalogOperation
): Schema.Codec<SuggestedOperationValue, SuggestedOperationValue> => {
  const tool = Schema.Literal(operation.id).annotate({
    description:
      "The canonical operation to call, spelled exactly as its `operationId` in this spec. " +
      "Look that id up here to see the complete input and result.",
  });

  return Option.match(operation.partialInput, {
    onNone: () => Schema.Struct({ tool, hint: SuggestedOperationHint }),
    onSome: (partialInput) =>
      Schema.Struct({
        tool,
        args: Schema.OptionFromOptionalKey(
          partialInput.annotate({
            description:
              "Arguments already worked out for that call. Partial by design: merge them into the " +
              "operation's own input rather than sending them as the whole of it.",
          })
        ),
        hint: SuggestedOperationHint,
      }),
  });
};

/**
 * A suggested next canonical call. `tool` accepts exactly a published operation
 * id; `args`, when present, is that target operation's schema-derived partial
 * input.
 */
export const SuggestedOperation = Schema.suspend(() => {
  const members = getBoundOperationCatalog()
    .operations.filter((operation) =>
      Option.isSome(userOwnedAgentCapability(operation.policy.access))
    )
    .map(suggestedOperationMember);
  if (!Arr.isReadonlyArrayNonEmpty(members)) {
    throw new Error("SuggestedOperation requires at least one canonical operation");
  }
  return Schema.Union(members);
})
  .pipe(Schema.brand("SuggestedOperation"))
  .annotate({ identifier: "SuggestedOperation" });
export type SuggestedOperation = typeof SuggestedOperation.Type;

/** At most three suggested canonical operations, possibly none, on success and failure. */
export const NextOperations = Schema.Array(SuggestedOperation)
  .check(Schema.isMaxLength(3))
  .annotate({
    description:
      "Where to go next: up to three canonical operations worth calling after this one, best " +
      "first. Empty when there is nothing worth suggesting, which is an answer rather than " +
      "an omission. Each entry has passed the target-input and caller-authorization checkpoint.",
  });

/** Supports the reflection guard that prevents endpoints from bypassing the universal envelope. */
export const isOperationResponse = (schema: Schema.Top): boolean =>
  Schema.resolveAnnotations(schema)?.operationResponse === true;

/**
 * The universal success response. Every canonical operation's success schema
 * is built with this combinator — top-level only, no per-operation opt-out.
 */
export const OperationResponse = <Data extends Schema.Top>(
  data: Data
): Schema.Struct<{
  readonly data: Data;
  readonly next: typeof NextOperations;
}> =>
  Schema.Struct({
    data,
    next: NextOperations,
  }).annotate({ operationResponse: true });

/** Canonical typed-error fragment used to derive the HTTP Retry-After header. */
export const CanonicalRetryAfterBody = Schema.Struct({
  error: Schema.Struct({
    retryAfterSeconds: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
});

/**
 * Closed canonical error vocabulary shared by every slice. Callers may branch
 * exhaustively on these codes; slices reuse the published meanings.
 * unauthenticated means unresolved credentials, consent_required means no
 * current onboarding grant, and user_action_required means explicit revocation
 * requiring the User to return to a Fidy-owned surface.
 */
export const ErrorCode = Schema.Literals([
  "validation_failed",
  "unauthenticated",
  "scope_missing",
  "consent_required",
  "user_action_required",
  "paywall_required",
  "rate_limited",
  "quota_exhausted",
  "not_found",
  "dashboard_uninitialized",
  "unavailable",
]);
export type ErrorCode = typeof ErrorCode.Type;

/** Shared protocol for expected canonical refusals that audit as rejected rather than failed. */
export const CanonicalRejectedFailure = Schema.Struct({
  canonicalOutcome: Schema.Literal("rejected"),
});
export type CanonicalRejectedFailure = typeof CanonicalRejectedFailure.Type;

export const isCanonicalRejectedFailure = Schema.is(CanonicalRejectedFailure);

const codeVocabulary = ErrorCode.literals.map((code) => `\`${code}\``).join(", ");

const detail = <Code extends ErrorCode>(
  code: Code
): Schema.Struct<{
  readonly code: Schema.Literal<Code>;
  readonly message: Schema.NonEmptyString;
}> =>
  Schema.Struct({
    code: Schema.Literal(code).annotate({
      description:
        `What went wrong, drawn from one closed set shared by every operation: ` +
        `${codeVocabulary}. Branch on this rather than on the status or the message; the ` +
        `set is small enough to cover exhaustively.`,
    }),
    message: Schema.NonEmptyString.check(Schema.isTrimmed()).annotate({
      description:
        "Why the call failed and what to do about it, written to you rather than to the " +
        "user. Decide your next move from it; do not relay it verbatim.",
    }),
  });

export const FieldIssue = Schema.Struct({
  path: Schema.optionalKey(
    Schema.NonEmptyString.annotate({
      description:
        "Dotted path to the value at fault inside what you sent — `amount`, or " +
        "`items.0.counterparty`. Present when the failure could be pinned to one value; absent " +
        "when it could not, and then `message` is about the request as a whole.",
    })
  ),
  message: Schema.String.annotate({
    description: "What that value should have been, phrased so you can correct it and retry.",
  }),
}).annotate({ identifier: "FieldIssue" });

const errorResponse = <Tag extends string, Detail extends Schema.Top>(
  tag: Tag,
  error: Detail
): {
  readonly _tag: ReturnType<typeof Schema.tagDefaultOmit<Tag>>;
  readonly error: Detail;
  readonly next: typeof NextOperations;
} => ({
  _tag: Schema.tagDefaultOmit(tag),
  error,
  next: NextOperations,
});

const validationFailedTag = "ValidationFailed";
const unauthenticatedTag = "Unauthenticated";
const scopeMissingTag = "ScopeMissing";
const consentRequiredTag = "ConsentRequired";
const userActionRequiredTag = "UserActionRequired";
const paywallRequiredTag = "PaywallRequired";
const notFoundTag = "NotFound";
const unavailableTag = "Unavailable";
const resourceLimitedTag = "ResourceLimited";

/** A Free capability remains available, but its concrete monthly allowance is exhausted. */
export class QuotaExhausted extends Schema.Error<QuotaExhausted>("QuotaExhausted")(
  errorResponse(
    "QuotaExhausted",
    Schema.Struct({
      ...detail("quota_exhausted").fields,
      allowance: AllowanceKind,
      resetsAt: Schema.DateTimeUtc,
    })
  ),
  { httpApiStatus: 429 }
) {}

/** Invalid input with attributable field issues; encoding omits the internal _tag. */
export class ValidationFailed extends Schema.Error<ValidationFailed>(validationFailedTag)(
  errorResponse(
    validationFailedTag,
    Schema.Struct({
      ...detail("validation_failed").fields,
      fields: Schema.Array(FieldIssue).annotate({
        description:
          "One entry per offending value. Nothing was written, so correct every one of them " +
          "and send the whole request again rather than only the parts named here.",
      }),
    })
  ),
  { httpApiStatus: 400 }
) {}

/**
 * The request named no caller, or one that could not be resolved to a user.
 * Carries no suggested operation: nothing the API offers changes a PAT.
 */
export class Unauthenticated extends Schema.Error<Unauthenticated>(unauthenticatedTag)(
  errorResponse(unauthenticatedTag, detail("unauthenticated")),
  {
    httpApiStatus: 401,
  }
) {}

/**
 * The bearer is valid but does not grant the scope declared by the attempted operation. PAT
 * changes happen at `/settings/access`, outside this canonical API, so the failure carries no
 * suggested operation.
 */
export class ScopeMissing extends Schema.Error<ScopeMissing>(scopeMissingTag)(
  errorResponse(scopeMissingTag, detail("scope_missing")),
  { httpApiStatus: 403 }
) {}

/** The stable User has no current onboarding grant, so no canonical operation may run. */
export class ConsentRequired extends Schema.Error<ConsentRequired>(consentRequiredTag)(
  errorResponse(consentRequiredTag, detail("consent_required")),
  {
    httpApiStatus: 403,
  }
) {}

/** Explicit revocation requires the User to return to a Fidy-owned surface before PAT work. */
export class UserActionRequired extends Schema.Error<UserActionRequired>(userActionRequiredTag)(
  errorResponse(userActionRequiredTag, detail("user_action_required")),
  {
    httpApiStatus: 403,
  }
) {}

/** The User has exhausted Free access to a capability that remains available in Pro. */
export class PaywallRequired extends Schema.Error<PaywallRequired>(paywallRequiredTag)(
  errorResponse(paywallRequiredTag, detail("paywall_required")),
  {
    httpApiStatus: 402,
  }
) {}

/** Missing and foreign records share the same caller-visible failure. */
export class NotFound extends Schema.Error<NotFound>(notFoundTag)(
  errorResponse(notFoundTag, detail("not_found")),
  { httpApiStatus: 404 }
) {}

/** The caller's stable-User request or write admission budget is exhausted. No domain write was accepted. */
export class ResourceLimited extends Schema.Error<ResourceLimited>(resourceLimitedTag)(
  errorResponse(
    resourceLimitedTag,
    Schema.Struct({
      ...detail("rate_limited").fields,
      retryAfterSeconds: Schema.optionalKey(
        CanonicalRetryAfterBody.fields.error.fields.retryAfterSeconds
      ),
    })
  ),
  { httpApiStatus: 429 }
) {}

/** A required private dependency could not complete the canonical operation. */
export class Unavailable extends Schema.Error<Unavailable>(unavailableTag)(
  errorResponse(
    unavailableTag,
    Schema.Struct({
      ...detail("unavailable").fields,
      retryAfterSeconds: Schema.optionalKey(
        CanonicalRetryAfterBody.fields.error.fields.retryAfterSeconds
      ),
    })
  ),
  { httpApiStatus: 503 }
) {}

const forwardErrorMessage = (
  ...prototypes: ReadonlyArray<{ readonly error: { readonly message: string } }>
): void => {
  for (const prototype of prototypes) {
    Object.defineProperty(prototype, "message", {
      get(this: { readonly error: { readonly message: string } }): string {
        return this.error.message;
      },
    });
  }
};

forwardErrorMessage(
  ValidationFailed.prototype,
  Unauthenticated.prototype,
  ScopeMissing.prototype,
  ConsentRequired.prototype,
  UserActionRequired.prototype,
  PaywallRequired.prototype,
  NotFound.prototype,
  Unavailable.prototype
);

/**
 * Declares the canonical validation failure for requests that do not satisfy an operation's
 * schemas. Invalid requests are reported as `ValidationFailed` with request-part field issues,
 * keeping this failure in every derived API surface.
 */
export class ValidationGate extends HttpApiMiddleware.Service<ValidationGate>()(
  "@fidy/server/shell/public-http/ValidationGate",
  { error: ValidationFailed }
) {}

export const okStatus = 200;

export const createdStatus = 201;

/** The response status for durable work accepted for asynchronous processing. */
export const acceptedStatus = 202;

export const unauthorizedStatus = 401;

export const forbiddenStatus = 403;

export const requestTimeoutStatus = 408;

export const conflictStatus = 409;

export const tooManyRequestsStatus = 429;

export const firstServerErrorStatus = 500;

export const serviceUnavailableStatus = 503;

export const lastServerErrorStatus = 599;

/**
 * Whether a response status describes a briefly unavailable HTTP resource: a request timeout,
 * conflict, rate limit, or any server failure. Callers keep their own retry bounds.
 */
export const isTransientHttpStatus = (status: number): boolean =>
  status === requestTimeoutStatus ||
  status === conflictStatus ||
  status === tooManyRequestsStatus ||
  status >= firstServerErrorStatus;

/**
 * Reports whether a parsed URL is exactly a credential-free HTTP(S) origin.
 * A root slash is the only accepted path; credentials, query parameters, and
 * fragments are rejected so callers can compare the returned origin exactly.
 */
export { isHttpOrigin } from "~/shell/browser-transport/contract";

/** Observes a canonical call without changing its success, failure, interruption, or requirements. */
export class CanonicalTelemetry extends HttpApiMiddleware.Service<CanonicalTelemetry>()(
  "@fidy/server/shell/public-http/contract/CanonicalTelemetry"
) {}
