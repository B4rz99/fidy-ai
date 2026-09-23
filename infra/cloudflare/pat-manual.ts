import {
  CreateManualPATPayload,
  IssuedManualPATResponse,
  ManualPATIssuanceConsumed,
  ManualPATIssuanceRateLimited,
  ManualPATReviewExpired,
  TokenBearer,
  UserActionRequired,
  ValidationFailed,
  buildPATDisclosure,
  issuanceConsumedMessage,
  issuanceLimitedMessage,
  issueManualPAT,
  recordSessionPATTransition,
  reviewExpiredMessage,
} from "@fidy/server/tokens-runtime";
import { type Cause, DateTime, Effect, Function, Option, Redacted, Result, Schema } from "effect";
import { grantManualPATConsent } from "@fidy/server/consent-pat";
import {
  type SessionRow,
  canonical,
  currentMillis,
  dayMilliseconds,
  decodeBody,
  digest,
  httpBadRequest,
  httpConflict,
  httpReviewExpired,
  httpTooManyRequests,
  issuanceWindowMilliseconds,
  maxIssuancesPerUserWindow,
  newBearer,
  newId,
  newShortId,
  pairingMilliseconds,
  patFrom,
  response,
  unauthorized,
  serviceUnavailable as unavailable,
  webSession,
} from "./pat-shared";
import { commitPATUnit, prepareOwnedStatement } from "./pat-unit";

const httpForbidden = 403;
const consentActionRequired = (): Response =>
  response(
    Schema.encodeSync(Schema.toCodecJson(UserActionRequired))(
      UserActionRequired.make({
        error: {
          code: "user_action_required",
          message: "Return to Fidy to review your withdrawn Consent.",
        },
        next: [],
      })
    ),
    httpForbidden
  );

const invalidReview = (): Response =>
  response(
    Schema.encodeSync(Schema.toCodecJson(ValidationFailed))(
      ValidationFailed.make({
        error: { code: "validation_failed", message: "Review the PAT grant again.", fields: [] },
        next: [],
      })
    ),
    httpBadRequest
  );
const expiredReview = (): Response =>
  response(
    Schema.encodeSync(Schema.toCodecJson(ManualPATReviewExpired))(
      ManualPATReviewExpired.make({
        error: { code: "user_action_required", message: reviewExpiredMessage },
        next: [],
      })
    ),
    httpReviewExpired
  );
const issuanceLimit = (): Response =>
  response(
    Schema.encodeSync(Schema.toCodecJson(ManualPATIssuanceRateLimited))(
      ManualPATIssuanceRateLimited.make({
        error: { code: "rate_limited", message: issuanceLimitedMessage, retryAfterSeconds: 600 },
        next: [],
      })
    ),
    httpTooManyRequests
  );
const consumed = (): Response =>
  response(
    Schema.encodeSync(Schema.toCodecJson(ManualPATIssuanceConsumed))(
      ManualPATIssuanceConsumed.make({
        error: { code: "user_action_required", message: issuanceConsumedMessage },
        next: [],
      })
    ),
    httpConflict
  );
type Issuance = Readonly<{
  input: CreateManualPATPayload;
  session: SessionRow;
  current: number;
  expires: number;
  patId: string;
  shortId: string;
  bearer: string;
}>;
/** Insert a grant, its exact disclosure and metadata-only audit as one D1 unit. */
const commitIssuance = (
  db: D1Database,
  issue: Issuance
): Effect.Effect<boolean, Cause.UnknownError> =>
  Effect.gen(function* () {
    const { input, session, current, expires, patId, shortId, bearer } = issue;
    const { grant, requestId } = input;
    const disclosure = buildPATDisclosure({ grant, expiresAt: DateTime.makeUnsafe(expires) });
    const bearerDigest = yield* Effect.tryPromise(() => digest(bearer));
    const committed = yield* Effect.tryPromise(() =>
      commitPATUnit(db, [
        prepareOwnedStatement(
          db,
          issueManualPAT(session, {
            grant,
            requestId,
            patId,
            shortId,
            bearerDigest,
            current,
            expires,
          })
        ),
        prepareOwnedStatement(
          db,
          grantManualPATConsent(session, {
            id: newId(),
            requestId,
            disclosure,
            current,
          })
        ),
        prepareOwnedStatement(
          db,
          recordSessionPATTransition(session, {
            id: newId(),
            current,
            patId: Option.some(patId),
            operation: "pats.createManualPAT",
          })
        ),
      ])
    );
    return committed.every((item) => item.meta.changes === 1);
  });
const issuedResponse = (issue: Issuance): Response => {
  const { input, session, current, expires, patId, shortId, bearer } = issue;
  const pat = patFrom({
    id: patId,
    user_id: session.user_id,
    short_id: shortId,
    recipient_label: input.grant.recipientLabel,
    scopes_json: JSON.stringify(input.grant.scopes),
    lifetime_days: input.grant.lifetimeDays,
    created_at_ms: current,
    expires_at_ms: expires,
    last_used_at_ms: null,
    revoked_at_ms: null,
  });
  if (Option.isNone(pat)) return unavailable();
  return canonical(
    Schema.encodeSync(Schema.toCodecJson(IssuedManualPATResponse))({
      pat: { ...pat.value, idleExpiresAt: DateTime.makeUnsafe(expires) },
      bearer: Redacted.make(Schema.decodeSync(TokenBearer)(bearer)),
    })
  );
};

const expiryFor = (
  grant: typeof CreateManualPATPayload.Type.grant,
  current: number
): Option.Option<number> => {
  const maximum = current + grant.lifetimeDays * dayMilliseconds;
  const reviewed = DateTime.toEpochMillis(grant.reviewExpiresAt);
  return reviewed > current && reviewed <= maximum && reviewed >= maximum - pairingMilliseconds
    ? Option.some(maximum)
    : Option.none();
};
const failedIssuance = (
  db: D1Database,
  requestId: string,
  userId: string
): Effect.Effect<Response, Cause.UnknownError> =>
  Effect.gen(function* () {
    const prior = yield* Effect.tryPromise(() =>
      db
        .prepare("SELECT 1 FROM pats WHERE request_id = ? AND user_id = ?")
        .bind(requestId, userId)
        .first()
    );
    if (prior !== null) return consumed();
    const revokedConsent = yield* Effect.tryPromise(() =>
      db.prepare("SELECT 1 FROM consent_user_revocations WHERE user_id = ?").bind(userId).first()
    );
    if (revokedConsent !== null) return consentActionRequired();
    const issued = yield* Effect.tryPromise(() =>
      db
        .prepare("SELECT count(*) AS total FROM pats WHERE user_id = ? AND issued_at_ms > ?")
        .bind(userId, currentMillis() - issuanceWindowMilliseconds)
        .first<{ total: number }>()
    );
    return issued !== null && issued.total >= maxIssuancesPerUserWindow
      ? issuanceLimit()
      : unavailable();
  });

/** Issue one manually reviewed User-owned bearer; failed or repeated ids never reveal it again. */
export const createManualPAT = Function.dual<
  (db: D1Database) => (request: Request) => Promise<Response>,
  (request: Request, db: D1Database) => Promise<Response>
>(2, (request, db) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* Effect.tryPromise(() => webSession(request, db, true));
      if (Option.isNone(session)) return unauthorized();
      const input = yield* Effect.tryPromise(() =>
        decodeBody(request, Schema.toCodecJson(CreateManualPATPayload))
      );
      if (Option.isNone(input)) return invalidReview();
      const current = currentMillis();
      const expiry = expiryFor(input.value.grant, current);
      if (Option.isNone(expiry)) return expiredReview();
      const shortId = newShortId();
      const issue = {
        input: input.value,
        session: session.value,
        current,
        expires: expiry.value,
        shortId,
        patId: newId(),
        bearer: newBearer(shortId),
      };
      const committed = yield* commitIssuance(db, issue).pipe(Effect.result);
      if (Result.isSuccess(committed) && committed.success) {
        const issued = yield* Effect.try(() => issuedResponse(issue)).pipe(Effect.result);
        if (Result.isSuccess(issued)) return issued.success;
      }
      return yield* failedIssuance(db, input.value.requestId, session.value.user_id);
    })
  )
);
