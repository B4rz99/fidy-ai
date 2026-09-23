import * as Arr from "effect/Array";
import { Option, Schema } from "effect";
import { HttpApiMiddleware } from "effect/unstable/httpapi";
import { type CatalogOperation, getBoundOperationCatalog } from "~/shell/_shared/operation-catalog";
import { patScopeCapability } from "~/shell/_shared/operation-policy";

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
    .operations.filter((operation) => Option.isSome(patScopeCapability(operation.policy.access)))
    .map(suggestedOperationMember);
  if (!Arr.isReadonlyArrayNonEmpty(members)) {
    throw new Error("SuggestedOperation requires at least one canonical operation");
  }
  return Schema.Union(members);
})
  .pipe(Schema.brand("SuggestedOperation"))
  .annotate({ identifier: "SuggestedOperation" });
export type SuggestedOperation = typeof SuggestedOperation.Type;

/**
 * The `next` field, declared once. Both success and error responses carry it on the same terms —
 * at most three suggested operations, possibly none — so a failure is as navigable
 * as a success; every declared error class reuses this schema rather than restating it.
 */
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
 * Every code an error response may carry, for every slice. Closed on purpose:
 * a calling agent can branch on this set and know it has covered the space, and
 * a new slice reuses a code rather than inventing a synonym for it.
 *
 * Four are declared ahead of the slices that raise them — `scope_missing`,
 * `paywall_required`, `rate_limited` and `quota_exhausted` wait on tokens,
 * billing and rate limiting. They are spelled now because the set is published
 * to agents as the space to cover: a code arriving later is a change to every
 * caller that had already covered it. The spec (GitHub issue #1) names all
 * four, and names them exactly this way — `paywall_required`, not
 * `payment_required`, because it is the Paywall the caller has met (CONTEXT.md)
 * and the string is the contract.
 *
 * `unauthenticated`, `consent_required`, and `user_action_required` are repository additions to
 * the spec's open-ended list: callers distinguish an unknown bearer, missing hosted Consent, and
 * explicit revocation that only the User can resolve on a Fidy-owned surface.
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
  "unavailable",
]);
export type ErrorCode = typeof ErrorCode.Type;

/** Shared protocol for expected canonical refusals that audit as rejected rather than failed. */
export const CanonicalRejectedFailure = Schema.Struct({
  canonicalOutcome: Schema.Literal("rejected"),
});
export type CanonicalRejectedFailure = typeof CanonicalRejectedFailure.Type;

/** Recognizes the declared canonical-rejection protocol without inspecting arbitrary objects. */
export const isCanonicalRejectedFailure = Schema.is(CanonicalRejectedFailure);

// The vocabulary an agent is handed, rendered from the set itself: spelling the
// codes out again in the prose would be a second copy of a closed set, drifting
// the moment one is added (ARCHITECTURE.md §4).
const codeVocabulary = ErrorCode.literals.map((code) => `\`${code}\``).join(", ");

/**
 * The body of an error response: the code, and a message addressed to the
 * calling agent — why it failed and what to do about it, in a sentence or two.
 * The code is pinned per error class so the derived spec advertises exactly
 * which one a given status carries.
 */
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
  /**
   * `optionalKey` rather than `optional`: absence is the key not being there.
   * `optional` is `optionalKey(UndefinedOr(...))`, which publishes `null` in an
   * `anyOf` beside the string — a second spelling of absence, in the one field
   * whose point is that there is only one (CODING_STANDARDS.md, never `null`).
   * Losing the `anyOf` also lifts the description a level, to where every other
   * refined field in the spec carries it.
   *
   * `NonEmptyString` closes the third spelling: a present but empty path would
   * be a value standing in for the lack of one.
   */
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

/**
 * The `{ error, next }` pair every API failure carries, declared once so the
 * classes below differ only in the detail they hand it.
 *
 * Returns struct *fields*, not a schema, so the result cannot be piped or
 * annotated: its one use is the first argument to `Schema.Error`, which
 * takes fields or a struct and normalises either. `OperationResponse` on the success
 * side has to return a schema because its results are piped through
 * `HttpApiSchema.status`; a failure takes its status from the annotation
 * argument of the same `ErrorClass` call instead, so it never needs to be one.
 */
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

/**
 * API failures are schema-backed tagged errors. Their `_tag` supports selective
 * in-process handling but is omitted during encoding because `code` is the
 * caller-facing discriminator an agent can enumerate (ARCHITECTURE.md §6).
 *
 * The request did not satisfy the operation's input schema. Carries whatever the
 * gate could attribute to individual values rather than the parser's own
 * rendering of the failure.
 */
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
 * changes happen at `/settings/pats`, outside this canonical API, so the failure carries no
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

/**
 * The record the caller asked for is not theirs to see. Slices raise this
 * through their own mapper, which supplies a message naming what was missing.
 */
export class NotFound extends Schema.Error<NotFound>(notFoundTag)(
  errorResponse(notFoundTag, detail("not_found")),
  { httpApiStatus: 404 }
) {}

/** The caller's stable-User write budget is exhausted for the current admission window. */
export class ResourceLimited extends Schema.Error<ResourceLimited>(resourceLimitedTag)(
  errorResponse(resourceLimitedTag, detail("rate_limited")),
  { httpApiStatus: 429 }
) {}

/** A required private dependency could not complete the canonical operation. */
export class Unavailable extends Schema.Error<Unavailable>(unavailableTag)(
  errorResponse(unavailableTag, detail("unavailable")),
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

/** The response status carried by a successful read. */
export const okStatus = 200;

/** The response status a canonical operation declares when it creates a record. */
export const createdStatus = 201;

/** The response status for durable work accepted for asynchronous processing. */
export const acceptedStatus = 202;

/** The status a caller receives when it presented no usable credential. */
export const unauthorizedStatus = 401;

/** The status a caller receives when its credential does not reach the resource. */
export const forbiddenStatus = 403;

/** The status a server returns when it gave up waiting for the request. */
export const requestTimeoutStatus = 408;

/** The status a server returns when the request conflicted with concurrent state. */
export const conflictStatus = 409;

/** The status a server returns when the caller exceeded a rate limit. */
export const tooManyRequestsStatus = 429;

/** Lowest status in the range that blames the server rather than the caller. */
export const firstServerErrorStatus = 500;

/** The status returned when a required server dependency is unavailable. */
export const serviceUnavailableStatus = 503;

/** Highest status in the range that blames the server rather than the caller. */
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
export const isHttpOrigin = (url: URL): boolean =>
  (url.protocol === "http:" || url.protocol === "https:") &&
  url.username.length === 0 &&
  url.password.length === 0 &&
  url.pathname === "/" &&
  url.search.length === 0 &&
  url.hash.length === 0;
