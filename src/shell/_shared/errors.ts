import { Effect, Option, Schema, SchemaIssue } from "effect";
import { type HttpApiError, HttpApiMiddleware } from "effect/unstable/httpapi";
import { NextAffordances } from "./envelope";

/**
 * Every code an error envelope may carry, for every slice. Closed on purpose:
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
 * `unauthenticated` is the one this repo added rather than the spec: the spec's
 * list is open-ended and the caller has to be told when the request named
 * nobody.
 */
export const ErrorCode = Schema.Literals([
  "validation_failed",
  "unauthenticated",
  "scope_missing",
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
 * The body of an error envelope: the code, and a message addressed to the
 * calling agent — why it failed and what to do about it, in a sentence or two.
 * The code is pinned per error class so the derived spec advertises exactly
 * which one a given status carries.
 */
const detail = <Code extends ErrorCode>(code: Code) =>
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

const FieldIssue = Schema.Struct({
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
        "`items.0.merchant`. Present when the failure could be pinned to one value; absent " +
        "when it could not, and then `message` is about the request as a whole.",
    })
  ),
  message: Schema.String.annotate({
    description: "What that value should have been, phrased so you can correct it and retry.",
  }),
}).annotate({ identifier: "FieldIssue" });

/**
 * The `{ error, next }` pair every wire failure carries, declared once so the
 * classes below differ only in the detail they hand it.
 *
 * Returns struct *fields*, not a schema, so the result cannot be piped or
 * annotated: its one use is the first argument to `Schema.ErrorClass`, which
 * takes fields or a struct and normalises either. `Envelope` on the success
 * side has to return a schema because its results are piped through
 * `HttpApiSchema.status`; a failure takes its status from the annotation
 * argument of the same `ErrorClass` call instead, so it never needs to be one.
 */
const errorEnvelope = <Detail extends Schema.Top>(error: Detail) => ({
  error,
  next: NextAffordances,
});

/**
 * Wire failures are `Schema.ErrorClass`, as `HttpApiError.ts` does for its own
 * (ARCHITECTURE.md §6). Unlike those, these carry no `_tag`: `code` already
 * discriminates, from a set an agent can enumerate.
 *
 * The request did not satisfy the operation's contract. Carries whatever the
 * gate could attribute to individual values rather than the parser's own
 * rendering of the failure.
 */
export class ValidationFailed extends Schema.ErrorClass<ValidationFailed>("ValidationFailed")(
  errorEnvelope(
    Schema.Struct({
      ...detail("validation_failed").fields,
      fields: Schema.Array(FieldIssue).annotate({
        description:
          "What could be established about the failure, which may be less than everything " +
          "wrong with the request: checking stops at the first value it rejects, so correcting " +
          "these can surface another. Nothing was written, so send the whole request again " +
          "rather than only the parts named here.",
      }),
    })
  ),
  { httpApiStatus: 400 }
) {}

/**
 * The request named no caller, or one that could not be resolved to a user.
 * Carries no affordance: nothing the API offers changes a credential.
 */
export class Unauthenticated extends Schema.ErrorClass<Unauthenticated>("Unauthenticated")(
  errorEnvelope(detail("unauthenticated")),
  { httpApiStatus: 401 }
) {}

/**
 * The record the caller asked for is not theirs to see. Slices raise this
 * through their own mapper, which supplies a message naming what was missing.
 */
export class NotFound extends Schema.ErrorClass<NotFound>("NotFound")(
  errorEnvelope(detail("not_found")),
  { httpApiStatus: 404 }
) {}

/**
 * How each rejected request component is named to the caller. A `Record` keyed
 * by the component rather than a `switch`, so a component this misses is a type
 * error at the same place a missing switch case would be.
 */
const requestPart: Record<Exclude<HttpApiError.HttpApiSchemaError["kind"], "Body">, string> = {
  Params: "path parameters",
  Query: "query string",
  Headers: "headers",
  Payload: "request body",
};

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

/** A `PropertyKey`, or the `{ key }` wrapper Standard Schema also permits. */
const segmentName = (segment: PropertyKey | { readonly key: PropertyKey }): string =>
  typeof segment === "object" ? String(segment.key) : String(segment);

/**
 * Which value an issue is about, as a dotted path. `None` when the formatter
 * gave nothing to name: a body rejected as a whole, and also — until the union
 * decoding behind the payload is addressed — a single wrong field that failed a
 * union candidate's discriminating literal, which reports one issue against the
 * whole payload. So `None` means the failure could not be pinned to a value,
 * not that no single value is at fault.
 *
 * The filter is on the joined path, not the segment count: it is the string
 * that has to satisfy `FieldIssue.path`'s `NonEmptyString`, and a lone empty
 * segment would otherwise encode as `""` and turn a 400 into a response-encode
 * failure.
 */
const issuePath = (
  segments: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined
): Option.Option<string> =>
  Option.fromUndefinedOr(segments).pipe(
    Option.map((present) => present.map(segmentName).join(".")),
    Option.filter((path) => path.length > 0)
  );

const fieldIssues = (cause: Schema.SchemaError): ReadonlyArray<typeof FieldIssue.Type> =>
  formatIssue(cause.issue).issues.map((issue) =>
    Option.match(issuePath(issue.path), {
      onNone: () => ({ message: issue.message }),
      onSome: (path) => ({ path, message: issue.message }),
    })
  );

/**
 * Cross-cutting concern, so it rides on middleware: the contract gate rejects a
 * request before any handler runs, and v4 renders that as a bodyless 400 unless
 * something intercepts it. This is that something, attached once in `api.ts`,
 * which also puts `ValidationFailed` into every operation's derived contract.
 *
 * A `Body` failure is the server failing to encode its own answer — the
 * caller's request was fine and there is nothing for them to fix — so it is
 * passed back untouched rather than blamed on them.
 */
export class ContractGate extends HttpApiMiddleware.Service<ContractGate>()(
  "fidy-ai/shell/_shared/errors/ContractGate",
  { error: ValidationFailed }
) {}

export const ContractGateLive = HttpApiMiddleware.layerSchemaErrorTransform(
  ContractGate,
  (schemaError) => {
    if (schemaError.kind === "Body") return Effect.fail(schemaError);

    return Effect.fail(
      ValidationFailed.make({
        error: {
          code: "validation_failed",
          message:
            `The ${requestPart[schemaError.kind]} did not satisfy this operation's contract. ` +
            `Correct every value listed in error.fields and send the request again.`,
          fields: fieldIssues(schemaError.cause),
        },
        next: [],
      })
    );
  }
);
