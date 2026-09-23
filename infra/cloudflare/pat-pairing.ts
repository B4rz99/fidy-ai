import {
  ApprovePATPairingPayload,
  PATPairingPublicCodeInput,
  PATPairingReview,
  StartPATPairingPayload,
  admitPairingReview,
  admitPairingSource,
  approvePairingGrant,
  buildPairedPATDisclosure,
  expireApprovedPairings,
  expireFixedPATs,
  pairingExpiryCompletion,
  patExpiryCompletion,
  recordSessionPATTransition,
  selectPATPairingPublicCodeSymbols,
  startPairingGrant,
  sweepPairingAdmission,
  sweepPairingReviews,
  sweepUnapprovedPairings,
} from "@fidy/server/tokens-runtime";
import { type Cause, DateTime, Effect, Encoding, Option, Result, Schema } from "effect";
import {
  expirePATConsents,
  expirePairingConsents,
  grantPairedPATConsent,
} from "@fidy/server/consent-pat";
import {
  type SessionRow,
  canonical,
  currentMillis,
  dayMilliseconds,
  decodeBody,
  digest,
  httpRateLimited,
  invalid,
  iso,
  newId,
  newProof,
  pairingMilliseconds,
  rejected,
  response,
  scopesFrom,
  unauthorized,
  unavailable,
  webSession,
} from "./pat-shared";
import { commitPATUnit, prepareOwnedStatement } from "./pat-unit";

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
  created_at_ms: Schema.Finite,
  expires_at_ms: Schema.Finite,
  state: Schema.Literals([
    "pending_approval",
    "approved_awaiting_claim",
    "claimed",
    "expired_unapproved",
    "revoked_unclaimed",
  ]),
  user_id: Schema.NullOr(Schema.String),
  approved_at_ms: Schema.NullOr(Schema.Finite),
  pat_expires_at_ms: Schema.NullOr(Schema.Finite),
  wrong_attempts: Schema.Int,
  last_poll_at_ms: Schema.NullOr(Schema.Finite),
  minimum_poll_seconds: Schema.Int,
});
export type PairingRow = typeof PairingRow.Type;

/** Reclaim unapproved anonymous metadata; never remove approved User-bound grant evidence. */
export const sweepExpiredPATPairings = (db: D1Database): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const current = currentMillis();
      yield* Effect.tryPromise(() =>
        db.batch([
          prepareOwnedStatement({
            db,
            statement: expirePairingConsents({ current, limit: scheduledSweepLimit }),
          }),
          prepareOwnedStatement({ db, statement: expireApprovedPairings(current) }),
          db.prepare(pairingExpiryCompletion).bind(current),
          prepareOwnedStatement({
            db,
            statement: expirePATConsents({ current, limit: scheduledSweepLimit }),
          }),
          prepareOwnedStatement({ db, statement: expireFixedPATs(current) }),
          db.prepare(patExpiryCompletion).bind(current),
          prepareOwnedStatement({
            db,
            statement: sweepUnapprovedPairings({ current, limit: scheduledSweepLimit }),
          }),
          prepareOwnedStatement({
            db,
            statement: sweepPairingAdmission({ current, limit: scheduledSweepLimit }),
          }),
          prepareOwnedStatement({
            db,
            statement: sweepPairingReviews({ current, limit: scheduledSweepLimit }),
          }),
        ])
      );
    })
  );
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
      db.batch([
        prepareOwnedStatement({
          db,
          statement: sweepPairingAdmission({ current, limit: scheduledSweepLimit }),
        }),
        prepareOwnedStatement({
          db,
          statement: admitPairingSource({ sourceDigest: source, current }),
        }),
        prepareOwnedStatement({
          db,
          statement: startPairingGrant({
            id: pairingId,
            publicCode: code,
            proofDigest,
            recipientLabel: payload.recipientLabel,
            scopes: payload.scopes,
            lifetimeDays: payload.lifetimeDays,
            current,
            expires,
          }),
        }),
      ])
    );
    return committed[2]?.meta.changes === 1;
  });
/** Bound anonymous creation before allocating a new pairing or storing its digest. */
export const startPATPairing = ({
  request,
  db,
}: Readonly<{ request: Request; db: D1Database }>): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const payload = yield* Effect.tryPromise(() =>
        decodeBody({ request, schema: StartPATPairingPayload })
      );
      if (Option.isNone(payload)) return invalid();
      const source = Schema.decodeUnknownOption(sourceDigest)(request.headers.get("x-pat-source"));
      if (Option.isNone(source)) return unavailable();
      const bytes = Encoding.decodeHex(source.value);
      if (Result.isFailure(bytes)) return unavailable();
      const current = currentMillis();
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
    })
  );

const admitReview = (
  db: D1Database,
  sessionId: string,
  current: number
): Effect.Effect<boolean, Cause.UnknownError> =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise(() =>
      prepareOwnedStatement({
        db,
        statement: admitPairingReview({
          id: newId(),
          sessionId,
          current,
        }),
      }).run()
    );
    return result.meta.changes === 1;
  });
/** Inspect a public code only for a fresh browser User, with bounded guessing. */
export const inspectPATPairing = ({
  request,
  db,
}: Readonly<{ request: Request; db: D1Database }>): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* Effect.tryPromise(() => webSession({ request, db, fresh: true }));
      if (Option.isNone(session)) return unauthorized();
      const current = currentMillis();
      if (!(yield* admitReview(db, session.value.id, current))) return rateLimited();
      const input = yield* Effect.tryPromise(() =>
        decodeBody({ request, schema: Schema.Struct({ publicCode: Schema.String }) })
      );
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
      if (Option.isNone(pairing)) return rejected();
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
    })
  );

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
          prepareOwnedStatement({
            db,
            statement: approvePairingGrant({
              session,
              input: {
                pairingId: pairing.id,
                current,
                expires,
              },
            }),
          }),
          prepareOwnedStatement({
            db,
            statement: grantPairedPATConsent({
              session,
              input: {
                id: newId(),
                pairingId: pairing.id,
                disclosure,
                current,
              },
            }),
          }),
          prepareOwnedStatement({
            db,
            statement: recordSessionPATTransition({
              session,
              input: {
                id: newId(),
                current,
                operation: "pats.approvePATPairing",
                patId: Option.none(),
              },
            }),
          }),
        ],
      })
    );
    return committed.every((item) => item.meta.changes === 1);
  });
/** Approve one reviewed immutable grant and append its exact User-bound disclosure atomically. */
export const approvePATPairing = ({
  request,
  db,
}: Readonly<{ request: Request; db: D1Database }>): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* Effect.tryPromise(() => webSession({ request, db, fresh: true }));
      if (Option.isNone(session)) return unauthorized();
      const payload = yield* Effect.tryPromise(() =>
        decodeBody({ request, schema: Schema.toCodecJson(ApprovePATPairingPayload) })
      );
      if (Option.isNone(payload)) return rejected();
      const current = currentMillis();
      const raw = yield* Effect.tryPromise(() =>
        db
          .prepare(`SELECT * FROM pat_pairings WHERE id = ? AND state = 'pending_approval'
    AND expires_at_ms > ?`)
          .bind(payload.value.pairingId, current)
          .first()
      );
      const pairing = Schema.decodeUnknownOption(PairingRow)(raw);
      if (Option.isNone(pairing)) return rejected();
      const expires = current + pairing.value.lifetime_days * dayMilliseconds;
      const scopes = scopesFrom(pairing.value.scopes_json);
      if (Option.isNone(scopes)) return unavailable();
      const disclosure = buildPairedPATDisclosure({
        grant: {
          recipientLabel: yield* Schema.decodeEffect(StartPATPairingPayload.fields.recipientLabel)(
            pairing.value.recipient_label
          ),
          scopes: scopes.value,
          lifetimeDays: yield* Schema.decodeUnknownEffect(
            StartPATPairingPayload.fields.lifetimeDays
          )(pairing.value.lifetime_days),
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
    })
  );
