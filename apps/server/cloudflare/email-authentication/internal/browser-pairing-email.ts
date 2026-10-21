import { prepareEmailSecurityLimit } from "./email-security-limit";
import {
  pendingBrowserPairingQuery,
  prepareProvedBrowserPairingApproval,
  provePendingBrowserPairing,
} from "../../browser-login/operations";
import {
  EmailAddress,
  EmailVerificationCode,
} from "../../../src/core/email-authentication/contract";
import { BrowserLoginPairingId } from "../../../src/core/browser-login/contract";
import { Clock, Crypto, Effect, Option, PlatformError, Schema } from "effect";
import { RequestBodyPolicy } from "../../http/contract";
import { readBoundedRequestBody } from "../../http/operations";

const Start = Schema.Struct({
  pairingId: BrowserLoginPairingId,
  privateVerifier: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u)),
  email: EmailAddress,
});
const Complete = Schema.Struct({
  pairingId: BrowserLoginPairingId,
  privateVerifier: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u)),
  combinedCode: EmailVerificationCode,
});
const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 512,
  deadlineMilliseconds: 2_000,
});
const workerCrypto = Crypto.make({
  randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    Effect.tryPromise({
      try: () =>
        crypto.subtle
          .digest(algorithm, Uint8Array.from(data))
          .then((bytes) => new Uint8Array(bytes)),
      catch: (cause) =>
        PlatformError.systemError({
          _tag: "Unknown",
          module: "WorkerCrypto",
          method: "digest",
          cause,
        }),
    }),
});
const newId = (): string => Effect.runSync(workerCrypto.randomUUIDv4().pipe(Effect.orDie));
const digestLength = 32;
const emailCooldownMilliseconds = 60_000;
const emailAdmissionWindowMilliseconds = 3_600_000;
const emailUserRequestsPerWindow = 5;
const emailGlobalRequestsPerWindow = 1_000;
const publicCodeLength = 9;
const secretOffset = 10;
const invalid = (): Response =>
  Response.json(
    {
      error: {
        code: "authentication_invalid",
        message: "El código no es válido. Inicia de nuevo o solicita otro correo.",
      },
    },
    { status: 400, headers: { "cache-control": "no-store" } }
  );
const pending = (): Response =>
  Response.json(
    { status: "pending", retryAfterSeconds: 60 },
    { status: 202, headers: { "cache-control": "no-store" } }
  );
const unavailable = (): Response =>
  Response.json(
    { status: "unavailable" },
    { status: 503, headers: { "cache-control": "no-store" } }
  );
const digest = (value: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(value))
    .then((bytes) => new Uint8Array(bytes));
const equalDigest = (left: ReadonlyArray<number>, right: Uint8Array): boolean => {
  if (left.length !== digestLength || right.length !== digestLength) return false;
  let difference = 0;
  for (let index = 0; index < digestLength; index++) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
};
const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, void> =>
  Effect.tryPromise({ try: run, catch: () => undefined });
const readProof = <A, Encoded>(
  request: Request,
  schema: Schema.Codec<A, Encoded>
): Promise<Option.Option<A>> => {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
  ) {
    return Promise.resolve(Option.none());
  }
  return Effect.runPromise(
    Effect.gen(function* () {
      const bytes = yield* readBoundedRequestBody(request, policy);
      const text = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        catch: () => undefined,
      });
      return Option.some(yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text));
    }).pipe(Effect.orElseSucceed(() => Option.none<A>()))
  );
};

const prepareEmailAdmission = (
  db: D1Database,
  current: number,
  workId: string
): ReadonlyArray<D1PreparedStatement> => [
  prepareEmailSecurityLimit({
    db,
    kind: "pairing",
    current,
    subject: {
      sql: "SELECT email_user_id AS user_id FROM browser_login_pairings WHERE email_work_id=?",
      params: [workId],
    },
  }),
  prepareEmailSecurityLimit({
    db,
    kind: "pairing-global",
    current,
    subject: {
      sql: "SELECT email_user_id AS user_id FROM browser_login_pairings WHERE email_work_id=?",
      params: [workId],
    },
  }),
];

type PairingEmailIntent = Readonly<{
  db: D1Database;
  proof: typeof Start.Type;
  expiresAt: number;
  current: number;
  workId: string;
}>;
const startPairingEmailIntent = ({
  db,
  proof,
  expiresAt,
  current,
  workId,
}: PairingEmailIntent): Effect.Effect<void, void> =>
  Effect.gen(function* () {
    const pairing = pendingBrowserPairingQuery({
      subject: { sql: "SELECT ? AS pairingId", params: [proof.pairingId] },
      current,
    });
    yield* attempt(() =>
      db.batch([
        db
          .prepare(`UPDATE browser_login_pairings SET email_work_id=incoming.work_id,email_user_id=incoming.user_id,
          email_address=incoming.email_address,email_credential_verified_at_ms=incoming.verified_at_ms,
          email_state='awaiting_delivery',email_expires_at_ms=incoming.expires_at_ms,
          email_generation=coalesce(email_generation,0)+1,email_last_requested_at_ms=incoming.requested_at_ms,
          email_public_code=NULL,email_proof_digest=NULL,email_proof_expires_at_ms=NULL,
          email_wrong_attempts=0,email_dispatch_attempted_at_ms=NULL
        FROM(SELECT p.pairingId AS pairing_id,? AS work_id,v.user_id,v.email_address,v.verified_at_ms,
          p.expiresAt AS expires_at_ms,? AS requested_at_ms
          FROM (${pairing.sql}) AS p JOIN (SELECT rowid,id AS user_id,verified_email_address AS email_address,email_verified_at_ms AS verified_at_ms FROM users WHERE verified_email_address IS NOT NULL) AS v ON v.email_address=?
          WHERE p.expiresAt=?
          AND NOT EXISTS(SELECT 1 FROM email_security_limits l
            WHERE l.kind='pairing' AND l.user_id=v.user_id AND l.window_started_at_ms>? AND l.requests>=?)
          AND NOT EXISTS(SELECT 1 FROM email_security_limits l
            WHERE l.kind='pairing-global' AND l.window_started_at_ms>? AND l.requests>=?)) AS incoming
        WHERE browser_login_pairings.id=incoming.pairing_id
          AND (email_work_id IS NULL OR(email_state NOT IN('approved','sending')
            AND email_generation<5 AND email_last_requested_at_ms<=?))`)
          .bind(
            workId,
            current,
            ...pairing.params,
            proof.email,
            expiresAt,
            current - emailAdmissionWindowMilliseconds,
            emailUserRequestsPerWindow,
            current - emailAdmissionWindowMilliseconds,
            emailGlobalRequestsPerWindow,
            current - emailCooldownMilliseconds
          ),
        ...prepareEmailAdmission(db, current, workId),
      ])
    );
  });

/** Start one bounded email proof only after the browser proves ownership of a pending pairing. */
export const startBrowserPairingEmail = (input: {
  request: Request;
  db: D1Database;
  onAccepted: (id: string) => void;
}): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { request, db } = input;
      const proof = yield* attempt(() => readProof(request, Start));
      if (Option.isNone(proof)) return invalid();
      const expiresAt = yield* provePendingBrowserPairing({
        db,
        pairingId: proof.value.pairingId,
        privateVerifier: proof.value.privateVerifier,
      }).pipe(Effect.mapError(() => undefined));
      if (Option.isNone(expiresAt)) return invalid();
      const current = yield* Clock.currentTimeMillis;
      const workId = newId();
      yield* startPairingEmailIntent({
        db,
        proof: proof.value,
        expiresAt: expiresAt.value,
        current,
        workId,
      });
      input.onAccepted(workId);
      return pending();
    }).pipe(Effect.catchCause(() => Effect.succeed(unavailable())))
  );

const rejectWrongEmailProof = (db: D1Database, workId: string): Promise<void> =>
  Effect.runPromise(
    attempt(() =>
      db
        .prepare(`UPDATE browser_login_pairings AS browser_pairing_email_proofs SET email_wrong_attempts = email_wrong_attempts + 1,
    email_state = CASE WHEN email_wrong_attempts + 1 >= 5 THEN 'rejected' ELSE email_state END,
    email_proof_digest = CASE WHEN email_wrong_attempts + 1 >= 5 THEN NULL ELSE email_proof_digest END,
    email_public_code = CASE WHEN email_wrong_attempts + 1 >= 5 THEN NULL ELSE email_public_code END,
    email_proof_expires_at_ms = CASE WHEN email_wrong_attempts + 1 >= 5 THEN NULL ELSE email_proof_expires_at_ms END
    WHERE email_work_id IS NOT NULL AND email_work_id = ? AND email_state = 'awaiting_proof' AND email_wrong_attempts < 5`)
        .bind(workId)
        .run()
    ).pipe(Effect.asVoid)
  );

const approveEmailPairing = (
  db: D1Database,
  input: { pairingId: string; workId: string; publicCode: string; current: number }
): Promise<boolean> => {
  const { pairingId, workId, publicCode, current } = input;
  return Effect.runPromise(
    Effect.map(
      attempt(() =>
        db.batch([
          prepareProvedBrowserPairingApproval({
            db,
            pairingId,
            current,
            subject: {
              sql: `SELECT e.user_id AS userId FROM (SELECT rowid,id AS pairing_id,email_work_id AS work_id,email_user_id AS user_id,email_address,email_credential_verified_at_ms AS credential_verified_at_ms,email_state AS state,email_public_code AS public_code,email_proof_digest AS proof_digest,email_proof_expires_at_ms AS proof_expires_at_ms,email_expires_at_ms AS expires_at_ms,email_generation AS generation,email_wrong_attempts AS wrong_attempts,email_last_requested_at_ms AS last_requested_at_ms,email_dispatch_attempted_at_ms AS dispatch_attempted_at_ms FROM browser_login_pairings WHERE email_work_id IS NOT NULL) AS e
              JOIN (SELECT rowid,id AS user_id,verified_email_address AS email_address,email_verified_at_ms AS verified_at_ms FROM users WHERE verified_email_address IS NOT NULL) AS v ON v.user_id = e.user_id
                AND v.email_address = e.email_address AND v.verified_at_ms = e.credential_verified_at_ms
              WHERE e.work_id = ? AND e.pairing_id = ? AND e.state = 'awaiting_proof' AND e.public_code = ?
                AND e.proof_expires_at_ms > ? AND e.expires_at_ms > ?`,
              params: [workId, pairingId, publicCode, current, current],
            },
          }),
          db
            .prepare(`UPDATE browser_login_pairings AS browser_pairing_email_proofs SET email_state = 'approved',
      email_proof_digest = NULL, email_public_code = NULL, email_proof_expires_at_ms = NULL
      WHERE email_work_id IS NOT NULL AND email_work_id = ? AND email_state = 'awaiting_proof' AND changes() = 1`)
            .bind(workId),
        ])
      ),
      (bound) => bound[0]?.meta.changes === 1 && bound[1]?.meta.changes === 1
    )
  );
};

const EmailProofRow = Schema.Struct({
  proof_digest: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
  wrong_attempts: Schema.Int,
  work_id: Schema.String.check(Schema.isUUID()),
});

/** Consume a mailbox proof and bind only its credential's stable User to the same browser challenge. */
export const completeBrowserPairingEmail = (input: {
  request: Request;
  db: D1Database;
}): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { request, db } = input;
      const proof = yield* attempt(() => readProof(request, Complete));
      if (Option.isNone(proof)) return invalid();
      {
        const expiresAt = yield* provePendingBrowserPairing({
          db,
          pairingId: proof.value.pairingId,
          privateVerifier: proof.value.privateVerifier,
        }).pipe(Effect.mapError(() => undefined));
        if (Option.isNone(expiresAt)) return invalid();
        const current = yield* Clock.currentTimeMillis;
        const publicCode = proof.value.combinedCode.slice(0, publicCodeLength);
        const raw = yield* attempt(() =>
          db
            .prepare(`SELECT proof_digest, wrong_attempts, work_id
      FROM (SELECT rowid,id AS pairing_id,email_work_id AS work_id,email_user_id AS user_id,email_address,email_credential_verified_at_ms AS credential_verified_at_ms,email_state AS state,email_public_code AS public_code,email_proof_digest AS proof_digest,email_proof_expires_at_ms AS proof_expires_at_ms,email_expires_at_ms AS expires_at_ms,email_generation AS generation,email_wrong_attempts AS wrong_attempts,email_last_requested_at_ms AS last_requested_at_ms,email_dispatch_attempted_at_ms AS dispatch_attempted_at_ms FROM browser_login_pairings WHERE email_work_id IS NOT NULL) AS browser_pairing_email_proofs WHERE pairing_id = ? AND public_code = ?
        AND state = 'awaiting_proof' AND proof_expires_at_ms > ? AND expires_at_ms > ?`)
            .bind(proof.value.pairingId, publicCode, current, current)
            .first()
        );
        if (raw === null) return invalid();
        const row = Schema.decodeUnknownOption(EmailProofRow)(raw);
        if (Option.isNone(row)) return unavailable();
        if (
          !equalDigest(
            row.value.proof_digest,
            yield* attempt(() => digest(proof.value.combinedCode.slice(secretOffset)))
          )
        ) {
          yield* attempt(() => rejectWrongEmailProof(db, row.value.work_id));
          return invalid();
        }
        if (
          !(yield* attempt(() =>
            approveEmailPairing(db, {
              pairingId: proof.value.pairingId,
              workId: row.value.work_id,
              publicCode,
              current,
            })
          ))
        ) {
          return invalid();
        }
        return Response.json(
          { status: "pairing_approved" },
          { headers: { "cache-control": "no-store" } }
        );
      }
    }).pipe(Effect.catchCause(() => Effect.succeed(unavailable())))
  );
