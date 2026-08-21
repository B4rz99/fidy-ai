import { Schema } from "effect";
import { HttpApiMiddleware } from "effect/unstable/httpapi";
import { NextOperations } from "./response";

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
]);
export type ErrorCode = typeof ErrorCode.Type;

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
 * annotated: its one use is the first argument to `Schema.ErrorClass`, which
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

/**
 * API failures are schema-backed tagged errors. Their `_tag` supports selective
 * in-process handling but is omitted during encoding because `code` is the
 * caller-facing discriminator an agent can enumerate (ARCHITECTURE.md §6).
 *
 * The request did not satisfy the operation's input schema. Carries whatever the
 * gate could attribute to individual values rather than the parser's own
 * rendering of the failure.
 */
export class ValidationFailed extends Schema.ErrorClass<ValidationFailed>(validationFailedTag)(
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
export class Unauthenticated extends Schema.ErrorClass<Unauthenticated>(unauthenticatedTag)(
  errorResponse(unauthenticatedTag, detail("unauthenticated")),
  { httpApiStatus: 401 }
) {}

/**
 * The bearer is valid but does not grant the scope declared by the attempted operation. PAT
 * changes happen at `/settings/pats`, outside this canonical API, so the failure carries no
 * suggested operation.
 */
export class ScopeMissing extends Schema.ErrorClass<ScopeMissing>(scopeMissingTag)(
  errorResponse(scopeMissingTag, detail("scope_missing")),
  { httpApiStatus: 403 }
) {}

/** The stable User has no current onboarding grant, so no canonical operation may run. */
export class ConsentRequired extends Schema.ErrorClass<ConsentRequired>(consentRequiredTag)(
  errorResponse(consentRequiredTag, detail("consent_required")),
  { httpApiStatus: 403 }
) {}

/** Explicit revocation requires the User to return to a Fidy-owned surface before PAT work. */
export class UserActionRequired extends Schema.ErrorClass<UserActionRequired>(
  userActionRequiredTag
)(errorResponse(userActionRequiredTag, detail("user_action_required")), { httpApiStatus: 403 }) {}

/** The User has exhausted Free access to a capability that remains available in Pro. */
export class PaywallRequired extends Schema.ErrorClass<PaywallRequired>(paywallRequiredTag)(
  errorResponse(paywallRequiredTag, detail("paywall_required")),
  { httpApiStatus: 402 }
) {}

/**
 * The record the caller asked for is not theirs to see. Slices raise this
 * through their own mapper, which supplies a message naming what was missing.
 */
export class NotFound extends Schema.ErrorClass<NotFound>(notFoundTag)(
  errorResponse(notFoundTag, detail("not_found")),
  { httpApiStatus: 404 }
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
  NotFound.prototype
);

/**
 * Declares the canonical validation failure for requests that do not satisfy an operation's
 * schemas. Invalid requests are reported as `ValidationFailed` with request-part field issues,
 * keeping this failure in every derived API surface.
 */
export class ValidationGate extends HttpApiMiddleware.Service<ValidationGate>()(
  "@fidy/server/shell/_shared/errors/ValidationGate",
  { error: ValidationFailed }
) {}
