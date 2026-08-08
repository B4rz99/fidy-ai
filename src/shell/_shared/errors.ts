import { Effect, Option, Result, Schema, SchemaIssue } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import {
  type HttpApiEndpoint,
  type HttpApiError,
  HttpApiMiddleware,
} from "effect/unstable/httpapi";
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
 * `unauthenticated` and `consent_required` are repository additions to the
 * spec's open-ended list: callers must distinguish a request that names nobody
 * from one whose User has not authorized processing.
 */
export const ErrorCode = Schema.Literals([
  "validation_failed",
  "unauthenticated",
  "scope_missing",
  "consent_required",
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
const errorResponse = <Detail extends Schema.Top>(
  error: Detail
): { error: Detail; next: typeof NextOperations } => ({
  error,
  next: NextOperations,
});

/**
 * API failures are `Schema.ErrorClass`, as `HttpApiError.ts` does for its own
 * (ARCHITECTURE.md §6). Unlike those, these carry no `_tag`: `code` already
 * discriminates, from a set an agent can enumerate.
 *
 * The request did not satisfy the operation's input schema. Carries whatever the
 * gate could attribute to individual values rather than the parser's own
 * rendering of the failure.
 */
export class ValidationFailed extends Schema.ErrorClass<ValidationFailed>("ValidationFailed")(
  errorResponse(
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
 * Carries no suggested operation: nothing the API offers changes an AgentToken.
 */
export class Unauthenticated extends Schema.ErrorClass<Unauthenticated>("Unauthenticated")(
  errorResponse(detail("unauthenticated")),
  { httpApiStatus: 401 }
) {}

/**
 * The bearer is a valid AgentToken but does not grant the scope declared by the
 * attempted operation. Token changes happen in chat, outside this canonical API,
 * so the failure carries no suggested operation.
 */
export class ScopeMissing extends Schema.ErrorClass<ScopeMissing>("ScopeMissing")(
  errorResponse(detail("scope_missing")),
  { httpApiStatus: 403 }
) {}

/** The stable User has no current onboarding grant, so no canonical operation may run. */
export class ConsentRequired extends Schema.ErrorClass<ConsentRequired>("ConsentRequired")(
  errorResponse(detail("consent_required")),
  { httpApiStatus: 403 }
) {}

/**
 * The record the caller asked for is not theirs to see. Slices raise this
 * through their own mapper, which supplies a message naming what was missing.
 */
export class NotFound extends Schema.ErrorClass<NotFound>("NotFound")(
  errorResponse(detail("not_found")),
  {
    httpApiStatus: 404,
  }
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

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) => {
    switch (issue._tag) {
      case "MissingKey":
        return "Missing key";
      case "UnexpectedKey":
        return "Unexpected key";
      case "OneOf":
        return "Expected exactly one schema member to match";
      case "Forbidden":
        return "Expected an operation allowed by this schema";
      case "InvalidValue":
        return "Expected a value accepted by this schema";
      case "InvalidType":
        return SchemaIssue.defaultLeafHook(issue).replace(/, got[\s\S]*$/u, "");
    }
  },
  checkHook: (issue) => {
    const annotated = SchemaIssue.defaultCheckHook(issue);
    if (annotated !== undefined) return annotated;
    if (issue.issue._tag !== "InvalidValue") return undefined;

    const expected = issue.filter.annotations?.expected;
    return typeof expected === "string"
      ? `Expected ${expected}`
      : "Expected a value satisfying this schema's constraints";
  },
});

/** A `PropertyKey`, or the `{ key }` wrapper Standard Schema also permits. */
const segmentName = (segment: PropertyKey | { readonly key: PropertyKey }): string =>
  typeof segment === "object" ? String(segment.key) : String(segment);

/**
 * Which value an issue is about, as a dotted path. `None` when the formatter
 * gave nothing to name, such as a body rejected as a whole. Payload failures
 * against a single schema are decoded without the framework's union wrapper
 * before reaching here, so a discriminating literal still names its field.
 *
 * The filter is on the joined path, not the segment count: it is the string
 * that has to satisfy `FieldIssue.path`'s `NonEmptyString`, and a lone empty
 * segment would otherwise encode as `""` and turn a 400 into a response-encode
 * failure.
 */
const issuePath = (
  segments: Option.Option<ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>>
): Option.Option<string> =>
  segments.pipe(
    Option.map((present) => present.map(segmentName).join(".")),
    Option.filter((path) => path.length > 0)
  );

const fieldIssues = (cause: Schema.SchemaError): ReadonlyArray<typeof FieldIssue.Type> =>
  formatIssue(cause.issue).issues.map((issue) =>
    Option.match(issuePath(Option.fromUndefinedOr(issue.path)), {
      onNone: () => ({
        message: "Expected the whole value to match this operation's input schema.",
      }),
      onSome: (path) => ({ path, message: issue.message }),
    })
  );

/**
 * Narrows the service requirement erased by `HttpApiEndpoint.Top`. Canonical
 * payload schemas come from core, whose compile-time fence requires `never`
 * services (ARCHITECTURE.md §3); the runtime schema cannot expose that phantom
 * type for a structural check.
 */
const isServiceFreePayloadSchema = (schema: Schema.Top): schema is Schema.Codec<unknown, unknown> =>
  Reflect.has(schema, "ast");

/**
 * Re-checks a rejected JSON value against its one declared payload schema.
 * HttpApiBuilder always wraps payload schemas in a union and decodes with the
 * default first-error mode. The wrapper can discard the field issue when a
 * literal candidate does not match; decoding the member directly with all
 * errors preserves both field paths and the complete correction list.
 *
 * Multiple payload schemas represent content negotiation. Without the request
 * content type at this middleware seam, choosing one would risk publishing
 * issues from the wrong operation schema, so those retain the framework's original
 * issue tree.
 */
const payloadFieldIssues = (
  cause: Schema.SchemaError,
  endpoint: HttpApiEndpoint.Top
): ReadonlyArray<typeof FieldIssue.Type> => {
  const schemas = Array.from(endpoint.payload.values()).flatMap(({ schemas }) => schemas);
  const [schema, ...additionalSchemas] = schemas;
  const actual = SchemaIssue.getActual(cause.issue);

  if (
    schema === undefined ||
    additionalSchemas.length > 0 ||
    Option.isNone(actual) ||
    !isServiceFreePayloadSchema(schema)
  ) {
    return fieldIssues(cause);
  }

  return Result.match(Schema.decodeUnknownResult(schema, { errors: "all" })(actual.value), {
    onFailure: fieldIssues,
    onSuccess: () => fieldIssues(cause),
  });
};

/**
 * Cross-cutting concern, so it rides on middleware: the validation gate rejects a
 * request before any handler runs, and v4 renders that as a bodyless 400 unless
 * something intercepts it. This is that something, attached once in `api.ts`,
 * which also puts `ValidationFailed` into every operation's derived API definition.
 *
 * A `Body` failure is the server failing to encode its own answer — the
 * caller's request was fine and there is nothing for them to fix — so it is
 * answered as an empty 500 rather than the framework's empty 400.
 */
export class ValidationGate extends HttpApiMiddleware.Service<ValidationGate>()(
  "fidy-ai/shell/_shared/errors/ValidationGate",
  { error: ValidationFailed }
) {}

export const ValidationGateLive = HttpApiMiddleware.layerSchemaErrorTransform(
  ValidationGate,
  (schemaError, { endpoint }) => {
    if (schemaError.kind === "Body") {
      return Effect.succeed(HttpServerResponse.empty({ status: 500 }));
    }

    const kind = schemaError.kind;
    const fields =
      kind === "Payload"
        ? payloadFieldIssues(schemaError.cause, endpoint)
        : fieldIssues(schemaError.cause);

    return Effect.fail(
      ValidationFailed.make({
        error: {
          code: "validation_failed",
          message:
            `The ${requestPart[kind]} did not satisfy this operation's input schema. ` +
            `Correct every value listed in error.fields and send the request again.`,
          fields,
        },
        next: [],
      })
    );
  }
);
