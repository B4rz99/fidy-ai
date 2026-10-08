import {
  admitPairingReview,
  admitPairingSource,
  approvePairingGrant,
  expireApprovedPairings,
  expireFixedPATs,
  expiredPATGrants,
  expiredPairingGrants,
  pairingExpiryCompletion,
  patExpiryCompletion,
  startPairingGrant,
  sweepPairingAdmission,
  sweepPairingReviews,
  sweepUnapprovedPairings,
} from "../../../src/shell/tokens/operations";
import { recordSessionPATTransition } from "../../../src/shell/audit/operations";
import {
  ApprovePATPairingPayload,
  PATPairingPublicCodeInput,
  PATPairingReview,
  StartPATPairingPayload,
} from "../../../src/core/tokens/contract";
import {
  buildPairedPATDisclosure,
  selectPATPairingPublicCodeSymbols,
} from "../../../src/core/tokens/operations";
import { type Cause, Clock, DateTime, Effect, Option, Result, Schema } from "effect";
import { Hex } from "effect/encoding";
import {
  expirePATConsents,
  expirePairingConsents,
  grantPairedPATConsent,
} from "../../../src/shell/consent/operations";
import {
  type SessionRow,
  canonical,
  dayMilliseconds,
  decodeBody,
  digest,
  httpRateLimited,
  invalid,
  iso,
  newProof,
  pairingMilliseconds,
  rejected,
  response,
  retainedPATMillis,
  scopesFrom,
  unauthorized,
  unavailable,
  webSession,
} from "./pat-shared";
import { newId } from "../../secret-material/operations";
import { commitPATUnit } from "./pat-unit";

const symbolCount = 8;
const sampleBytes = 16;
const scheduledSweepLimit = 4000;
const sourceDigest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const reviewRetrySeconds = 60;
const successStatus = 200;
const rateLimited = (): Response =>
  response({
    body: {
      error: {
        code: "rate_limited",
        message: "This PAT pairing is invalid or no longer available. Start a new request.",
        retryAfterSeconds: reviewRetrySeconds,
      },
      next: [],
    },
    status: httpRateLimited,
  });
const publicCode = (): string => {
  let symbols = "";
  while (symbols.length < symbolCount) {
    symbols += selectPATPairingPublicCodeSymbols({
      bytes: Array.from(crypto.getRandomValues(new Uint8Array(sampleBytes))),
      maximum: symbolCount - symbols.length,
    });
  }
  return `${symbols.slice(0, 4)}-${symbols.slice(4)}`;
};
export const PairingRow = Schema.Struct({
  id: Schema.String,
  proof_digest: Schema.Array(Schema.Int),
  public_code: Schema.String,
  recipient_label: Schema.String,
  scopes_json: Schema.String,
  lifetime_days: Schema.Int,
  created_at_ms: retainedPATMillis,
  expires_at_ms: retainedPATMillis,
  state: Schema.Literals([
    "pending_approval",
    "approved_awaiting_claim",
    "claimed",
    "expired_unapproved",
    "revoked_unclaimed",
  ]),
  user_id: Schema.NullOr(Schema.String),
  approved_at_ms: Schema.NullOr(retainedPATMillis),
  pat_expires_at_ms: Schema.NullOr(retainedPATMillis),
  wrong_attempts: Schema.Int,
  last_poll_at_ms: Schema.NullOr(retainedPATMillis),
  minimum_poll_seconds: Schema.Int,
});
export type PairingRow = typeof PairingRow.Type;

/** Reclaim unapproved anonymous metadata; never remove approved User-bound grant evidence. */
export const sweepExpiredPATPairings = (db: D1Database): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    yield* Effect.tryPromise(() =>
      db.batch(
        [
          expirePairingConsents({
            current,
            candidates: expiredPairingGrants({ current, limit: scheduledSweepLimit }),
          }),
          expireApprovedPairings(current),
          pairingExpiryCompletion(current),
          expirePATConsents({
            current,
            candidates: expiredPATGrants({ current, limit: scheduledSweepLimit }),
          }),
          expireFixedPATs(current),
          patExpiryCompletion(current),
          sweepUnapprovedPairings({ current, limit: scheduledSweepLimit }),
          sweepPairingAdmission({ current, limit: scheduledSweepLimit }),
          sweepPairingReviews({ current, limit: scheduledSweepLimit }),
        ].map(({ sql, params }) => db.prepare(sql).bind(...params))
      )
    );
  });
type StartedPairing = Readonly<{
  source: Uint8Array;
  payload: StartPATPairingPayload;
  current: number;
  code: string;
  privateCode: string;
  pairingId: string;
  expires: number;
}>;
const reservePairing = (
  db: D1Database,
  start: StartedPairing
): Effect.Effect<boolean, Cause.UnknownError> =>
  Effect.gen(function* () {
    const { source, payload, current, code, privateCode, pairingId, expires } = start;
    const proofDigest = yield* Effect.tryPromise(() => digest(privateCode));
    const committed = yield* Effect.tryPromise(() =>
      db.batch(
        [
          sweepPairingAdmission({ current, limit: scheduledSweepLimit }),
          admitPairingSource({ sourceDigest: source, current }),
          startPairingGrant({
            id: pairingId,
            publicCode: code,
            proofDigest,
            recipientLabel: payload.recipientLabel,
            scopes: payload.scopes,
            lifetimeDays: payload.lifetimeDays,
            current,
            expires,
          }),
        ].map(({ sql, params }) => db.prepare(sql).bind(...params))
      )
    );
    return committed[2]?.meta.changes === 1;
  });
/** Bound anonymous creation before allocating a new pairing or storing its digest. */
export const startPATPairing = ({
  request,
  db,
}: Readonly<{ request: Request; db: D1Database }>): Effect.Effect<Response, Cause.UnknownError> =>
  Effect.gen(function* () {
    const payload = yield* decodeBody({ request, schema: StartPATPairingPayload });
    if (Option.isNone(payload)) return invalid();
    const source = Schema.decodeUnknownOption(sourceDigest)(request.headers.get("x-pat-source"));
    if (Option.isNone(source)) return unavailable();
    const bytes = Hex.decode(source.value);
    if (Result.isFailure(bytes)) return unavailable();
    const current = yield* Clock.currentTimeMillis;
    const code = publicCode();
    const privateCode = newProof();
    const pairingId = newId();
    const expires = current + pairingMilliseconds;
    return yield* reservePairing(db, {
      source: bytes.success,
      payload: payload.value,
      current,
      code,
      privateCode,
      pairingId,
      expires,
    }).pipe(
      Effect.map((reserved) =>
        reserved
          ? response({
              body: {
                pairingId,
                privateDeviceCode: privateCode,
                publicCode: code,
                expiresAt: iso(expires),
                pollingIntervalSeconds: 5,
              },
              status: successStatus,
            })
          : rateLimited()
      ),
      Effect.orElseSucceed(() => unavailable())
    );
  });

const admitReview = (
  db: D1Database,
  sessionId: string,
  current: number
): Effect.Effect<boolean, Cause.UnknownError> =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise(() => {
      const reviewStatement = admitPairingReview({
        id: newId(),
        sessionId,
        current,
      });
      return db
        .prepare(reviewStatement.sql)
        .bind(...reviewStatement.params)
        .run();
    });
    return result.meta.changes === 1;
  });
/** Inspect a public code only for a fresh browser User, with bounded guessing. */
export const inspectPATPairing = ({
  request,
  db,
}: Readonly<{ request: Request; db: D1Database }>): Effect.Effect<
  Response,
  Cause.UnknownError | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const session = yield* webSession({ request, db, fresh: true });
    if (Option.isNone(session)) return unauthorized();
    const current = yield* Clock.currentTimeMillis;
    if (!(yield* admitReview(db, session.value.id, current))) return rateLimited();
    const input = yield* decodeBody({
      request,
      schema: Schema.Struct({ publicCode: Schema.String }),
    });
    const code = Option.flatMap(input, (value) =>
      Schema.decodeOption(PATPairingPublicCodeInput)(value.publicCode)
    );
    if (Option.isNone(code)) return rejected();
    const raw = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT * FROM pat_pairings WHERE public_code = ? AND state = 'pending_approval'
    AND expires_at_ms > ?`)
        .bind(code.value, current)
        .first()
    );
    const pairing = Schema.decodeUnknownOption(PairingRow)(raw);
    if (Option.isNone(pairing)) return raw === null ? rejected() : unavailable();
    const scopes = scopesFrom(pairing.value.scopes_json);
    if (Option.isNone(scopes)) return unavailable();
    const review = Schema.decodeUnknownOption(Schema.toType(PATPairingReview))({
      pairingId: pairing.value.id,
      recipientLabel: pairing.value.recipient_label,
      scopes: scopes.value,
      lifetimeDays: pairing.value.lifetime_days,
      claimBy: DateTime.makeUnsafe(pairing.value.expires_at_ms),
    });
    return Option.isSome(review)
      ? canonical(yield* Schema.encodeEffect(Schema.toCodecJson(PATPairingReview))(review.value))
      : unavailable();
  });

type Approval = Readonly<{
  session: SessionRow;
  pairing: PairingRow;
  current: number;
  expires: number;
  disclosure: string;
}>;
const commitApproval = (
  db: D1Database,
  approval: Approval
): Effect.Effect<boolean, Cause.UnknownError> =>
  Effect.gen(function* () {
    const { session, pairing, current, expires, disclosure } = approval;
    const committed = yield* Effect.tryPromise(() =>
      commitPATUnit({
        db,
        statements: [
          approvePairingGrant({
            session,
            input: {
              pairingId: pairing.id,
              current,
              expires,
            },
          }),

          grantPairedPATConsent({
            session,
            input: {
              id: newId(),
              pairingId: pairing.id,
              disclosure,
              current,
            },
          }),

          recordSessionPATTransition({
            session,
            input: {
              id: newId(),
              current,
              operation: "pats.approvePATPairing",
              patId: Option.none(),
            },
          }),
        ].map(({ sql, params }) => db.prepare(sql).bind(...params)),
      })
    );
    return committed.every((item) => item.meta.changes === 1);
  });
/** Approve one reviewed immutable grant and append its exact User-bound disclosure atomically. */
export const approvePATPairing = ({
  request,
  db,
}: Readonly<{ request: Request; db: D1Database }>): Effect.Effect<
  Response,
  Cause.UnknownError | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const session = yield* webSession({ request, db, fresh: true });
    if (Option.isNone(session)) return unauthorized();
    const payload = yield* decodeBody({
      request,
      schema: Schema.toCodecJson(ApprovePATPairingPayload),
    });
    if (Option.isNone(payload)) return rejected();
    const current = yield* Clock.currentTimeMillis;
    const raw = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT * FROM pat_pairings WHERE id = ? AND state = 'pending_approval'
    AND expires_at_ms > ?`)
        .bind(payload.value.pairingId, current)
        .first()
    );
    const pairing = Schema.decodeUnknownOption(PairingRow)(raw);
    if (Option.isNone(pairing)) return raw === null ? rejected() : unavailable();
    const expires = current + pairing.value.lifetime_days * dayMilliseconds;
    const scopes = scopesFrom(pairing.value.scopes_json);
    if (Option.isNone(scopes)) return unavailable();
    const disclosure = buildPairedPATDisclosure({
      grant: {
        recipientLabel: yield* Schema.decodeEffect(StartPATPairingPayload.fields.recipientLabel)(
          pairing.value.recipient_label
        ),
        scopes: scopes.value,
        lifetimeDays: yield* Schema.decodeUnknownEffect(StartPATPairingPayload.fields.lifetimeDays)(
          pairing.value.lifetime_days
        ),
      },
      expiresAt: DateTime.makeUnsafe(expires),
    });
    if (
      !(yield* commitApproval(db, {
        session: session.value,
        pairing: pairing.value,
        current,
        expires,
        disclosure,
      }))
    ) {
      return rejected();
    }
    return canonical({
      pairingId: pairing.value.id,
      patExpiresAt: iso(expires),
      claimBy: iso(pairing.value.expires_at_ms),
    });
  });
