import { type CreateManualPATPayload, TokenBearer } from "../../../src/core/tokens/contract";
import {
  IssuedManualPATResponse,
  ManualPATIssuanceConsumed,
  ManualPATIssuanceRateLimited,
  ManualPATReviewExpired,
  issuanceConsumedMessage,
  issuanceLimitedMessage,
  reviewExpiredMessage,
} from "../../../src/shell/tokens/contract";
import { DateTime, Effect, Option, Redacted, Schema } from "effect";
import type { LocalMutationResult } from "../../canonical-admission/contract";
import { PATUnavailable } from "../contract";
import {
  type SessionRow,
  dayMilliseconds,
  httpConflict,
  httpReviewExpired,
  httpTooManyRequests,
  pairingMilliseconds,
  patFrom,
  response,
} from "./pat-shared";

export const expiredReview = (): Response =>
  response({
    body: Schema.encodeSync(Schema.toCodecJson(ManualPATReviewExpired))(
      ManualPATReviewExpired.make({
        error: { code: "user_action_required", message: reviewExpiredMessage },
        next: [],
      })
    ),
    status: httpReviewExpired,
  });

export const issuanceLimit = (): Response =>
  response({
    body: Schema.encodeSync(Schema.toCodecJson(ManualPATIssuanceRateLimited))(
      ManualPATIssuanceRateLimited.make({
        error: { code: "rate_limited", message: issuanceLimitedMessage, retryAfterSeconds: 600 },
        next: [],
      })
    ),
    status: httpTooManyRequests,
  });

export const consumed = (): Response =>
  response({
    body: Schema.encodeSync(Schema.toCodecJson(ManualPATIssuanceConsumed))(
      ManualPATIssuanceConsumed.make({
        error: { code: "user_action_required", message: issuanceConsumedMessage },
        next: [],
      })
    ),
    status: httpConflict,
  });

type Issuance = Readonly<{
  input: CreateManualPATPayload;
  session: SessionRow;
  current: number;
  expires: number;
  patId: string;
  shortId: string;
  bearer: string;
}>;

export const issuedResult = (
  issue: Issuance
): Effect.Effect<LocalMutationResult, PATUnavailable> => {
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

  return Option.match(pat, {
    onNone: () => Effect.fail(new PATUnavailable({ cause: Option.none() })),
    onSome: (value) =>
      Effect.succeed({
        status: 200,
        outcome: "success" as const,
        body: {
          data: Schema.encodeSync(Schema.toCodecJson(IssuedManualPATResponse))({
            pat: { ...value, idleExpiresAt: DateTime.makeUnsafe(expires) },
            bearer: Redacted.make(Schema.decodeSync(TokenBearer)(bearer)),
          }),
          next: [],
        },
      }),
  });
};

export const expiryFor = ({
  grant,
  current,
}: {
  grant: typeof CreateManualPATPayload.Type.grant;
  current: number;
}): Option.Option<number> => {
  const maximum = current + grant.lifetimeDays * dayMilliseconds;
  const reviewed = DateTime.toEpochMillis(grant.reviewExpiresAt);

  return reviewed > current && reviewed <= maximum && reviewed >= maximum - pairingMilliseconds
    ? Option.some(maximum)
    : Option.none();
};
