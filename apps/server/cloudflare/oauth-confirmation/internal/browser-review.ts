import { Effect, Option, Schema } from "effect";
import {
  OAuthOperationDecision,
  OAuthOperationReview,
  OAuthRequestId,
  oauthPaths,
} from "../../../src/shell/oauth-agents/contract";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { freshSessionConditions } from "../../../src/shell/web-session/operations";
import { RequestBodyPolicy } from "../../http/contract";
import { readBoundedRequestBody } from "../../http/operations";
import { type OAuthBrowserReviewInput, OAuthReviewBinding } from "../contract";

const maximumBodyBytes = 16384;
const bodyDeadlineMilliseconds = 3000;
const okStatus = 200;
const invalidStatus = 400;
const unavailableStatus = 503;
const bodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: maximumBodyBytes,
  deadlineMilliseconds: bodyDeadlineMilliseconds,
});
const Reference = Schema.Struct({ reference: OAuthRequestId });
type BrowserReviewInput = OAuthBrowserReviewInput & Readonly<{ disclosureRevision: string }>;

const Row = Schema.Struct({
  reference: OAuthRequestId,
  connection_id: OAuthOperationReview.fields.connectionId,
  claimed_client_name: OAuthOperationReview.fields.claimedClientName,
  operation: Schema.String,
  input_json: Schema.String,
  input_digest: OAuthOperationReview.fields.inputDigest,
  binding_json: Schema.String,
  disclosure_revision: Schema.String,
  expires_at_ms: Schema.Int,
  browser_approved_at_ms: Schema.NullOr(Schema.Int),
});
const response = (body: Schema.Json, status = okStatus): Response =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
const invalid = (): Response => response({ error: "invalid_request" }, invalidStatus);
const readChoice = Effect.fn(function* (request: Request) {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
    return yield* Effect.fail(undefined);
  }
  const bytes = yield* readBoundedRequestBody(request, bodyPolicy);
  const text = yield* Effect.try(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  return yield* Schema.decodeEffect(Schema.fromJsonString(OAuthOperationDecision), {
    onExcessProperty: "error",
  })(text);
});
const intentConditions = (input: BrowserReviewInput, reference: string): OwnedStatement => {
  const fresh = freshSessionConditions(input);
  const databaseCurrent =
    "(CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER))";
  return protectConsentStatement({
    subject: { _tag: "User", userId: input.session.user_id },
    requirement: "active",
    statement: {
      sql: `reference = ? AND user_id = ? AND disclosure_revision = ?
        AND expires_at_ms > ? AND expires_at_ms > ${databaseCurrent} AND ${fresh.sql}
        AND EXISTS (SELECT 1 FROM oauth_connections g WHERE g.id = oauth_operation_intents.connection_id
          AND g.user_id = oauth_operation_intents.user_id AND g.revoked_at_ms IS NULL
          AND g.expires_at_ms > ? AND g.expires_at_ms > ${databaseCurrent})`,
      params: [
        reference,
        input.session.user_id,
        input.disclosureRevision,
        input.current,
        ...fresh.params,
        input.current,
      ],
    },
  });
};
const decideIntent = Effect.fn(function* (
  input: BrowserReviewInput,
  choice: typeof OAuthOperationDecision.Type
) {
  if (choice.disclosureRevision !== input.disclosureRevision) return invalid();
  const guard = intentConditions(input, choice.reference);
  const sql =
    choice.decision === "cancel"
      ? `DELETE FROM oauth_operation_intents WHERE ${guard.sql} AND hex(input_digest) = ?`
      : `UPDATE oauth_operation_intents SET browser_approved_at_ms = ?, browser_session_id = ?
        WHERE ${guard.sql} AND hex(input_digest) = ? AND browser_approved_at_ms IS NULL`;
  const prefix = choice.decision === "approve" ? [input.current, input.session.id] : [];
  const result = yield* Effect.tryPromise(() =>
    input.db
      .prepare(sql)
      .bind(...prefix, ...guard.params, choice.inputDigest)
      .run()
  );
  return result.meta.changes === 1 ? response({ decided: true }) : invalid();
});
const projectIntent = Effect.fn(function* (input: BrowserReviewInput, reference: string) {
  const guard = intentConditions(input, reference);
  const raw = yield* Effect.tryPromise(() =>
    input.db
      .prepare(`SELECT reference, connection_id,
    (SELECT claimed_client_name FROM oauth_connections WHERE id = connection_id) AS claimed_client_name,
    operation,input_json,hex(input_digest) AS input_digest,binding_json,disclosure_revision,expires_at_ms,browser_approved_at_ms
    FROM oauth_operation_intents WHERE ${guard.sql}`)
      .bind(...guard.params)
      .first()
  );
  if (raw === null) return invalid();
  const row = yield* Schema.decodeUnknownEffect(Row)(raw);
  const binding = yield* Schema.decodeEffect(Schema.fromJsonString(OAuthReviewBinding))(
    row.binding_json
  );
  const review = yield* Schema.decodeEffect(OAuthOperationReview)({
    reference: row.reference,
    connectionId: row.connection_id,
    claimedClientName: row.claimed_client_name,
    operation: row.operation,
    inputJson: row.input_json,
    effects: binding.map(({ operation, effect }) => `${operation}: ${effect}`),
    inputDigest: row.input_digest,
    disclosureRevision: row.disclosure_revision,
    expiresAtMilliseconds: row.expires_at_ms,
    approved: row.browser_approved_at_ms !== null,
  });
  return response(yield* Schema.encodeEffect(OAuthOperationReview)(review));
});
/** Called after first-party Origin, fresh session, CSRF binding and User admission checks. */
export const browserOperationReview = (input: BrowserReviewInput): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (new URL(input.request.url).pathname === oauthPaths.operationDecision) {
      const choice = yield* readChoice(input.request).pipe(Effect.option);
      return Option.isSome(choice) ? yield* decideIntent(input, choice.value) : invalid();
    }
    const reference = yield* Schema.decodeUnknownEffect(Reference, { onExcessProperty: "error" })(
      Object.fromEntries(new URL(input.request.url).searchParams)
    ).pipe(Effect.option);
    return Option.isSome(reference)
      ? yield* projectIntent(input, reference.value.reference)
      : invalid();
  }).pipe(
    Effect.catchCause(() =>
      Effect.succeed(response({ error: "temporarily_unavailable" }, unavailableStatus))
    )
  );
