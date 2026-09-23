import {
  PAT,
  PATScopes,
  TokenBearer,
  TokenShortId,
  patPairingUnavailableBody,
} from "@fidy/server/tokens-runtime";
import { Clock, DateTime, Effect, Encoding, Option, Schema } from "effect";
import { RequestBodyPolicy, readBoundedRequestBody } from "./request-body";

const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 1024,
  deadlineMilliseconds: 2_000,
});
export const pairingMilliseconds = 600_000;
export const dayMilliseconds = 86_400_000;
export const digestBytes = 32;
export const maxActivePATs = 100;
export const shortLength = 8;
const bearerLength = 56;
const sampleSize = 16;
export const httpBadRequest = 400;
export const httpUnauthorized = 401;
export const httpNotFound = 404;
export const httpUnavailable = 503;
export const httpConflict = 409;
export const httpReviewExpired = 422;
export const httpRateLimited = 429;
const unbiasedBase36Limit = 252;
const shortAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Bounded proof-free projection of an authenticated WebSession. */
export const SessionRow = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  user_id: Schema.String.check(Schema.isUUID()),
});
export type SessionRow = typeof SessionRow.Type;
/** One decoded grant row; caller supplies its explicit subject when reading owned data. */
export const PATRow = Schema.Struct({
  id: Schema.String,
  user_id: Schema.String,
  short_id: Schema.String,
  recipient_label: Schema.String,
  scopes_json: Schema.String,
  lifetime_days: Schema.Int,
  created_at_ms: Schema.Finite,
  expires_at_ms: Schema.Finite,
  last_used_at_ms: Schema.NullOr(Schema.Finite),
  revoked_at_ms: Schema.NullOr(Schema.Finite),
});
export type PATRow = typeof PATRow.Type;

/** Server-observed time, never a caller-supplied deadline. */
export const currentMillis = (): number => Effect.runSync(Clock.currentTimeMillis);
// @effect-diagnostics-next-line cryptoRandomUUID:off
export const newId = (): string => crypto.randomUUID();
export const iso = (milliseconds: number): string =>
  DateTime.formatIso(DateTime.makeUnsafe(milliseconds));
/** Fast SHA-256 is safe here only because inputs are 256-bit randomly generated bearers. */
export const digest = (text: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(text))
    .then((bytes) => new Uint8Array(bytes));
/** Length-checked constant-work comparison for stored and candidate digests. */
export const equalsDigest = (stored: ReadonlyArray<number>, candidate: Uint8Array): boolean => {
  if (stored.length !== digestBytes || candidate.length !== digestBytes) return false;
  let difference = 0;
  for (let index = 0; index < digestBytes; index++) {
    difference |= (stored[index] ?? 0) ^ (candidate[index] ?? 0);
  }
  return difference === 0;
};
/** Opaque private proof; no raw value is ever stored. */
export const newProof = (): string =>
  Encoding.encodeBase64Url(crypto.getRandomValues(new Uint8Array(digestBytes)));
/** Uniform human-readable safe short id, never authentication material. */
export const newShortId = (): string => {
  let shortId = "";
  while (shortId.length < shortLength) {
    for (const byte of crypto.getRandomValues(new Uint8Array(sampleSize))) {
      if (byte < unbiasedBase36Limit && shortId.length < shortLength) {
        shortId += shortAlphabet[byte % shortAlphabet.length];
      }
    }
  }
  return shortId;
};
export const newBearer = (shortId: string): string => `fin_${shortId}_${newProof()}`;
export const validBearer = (value: string): boolean =>
  value.length === bearerLength && Schema.is(TokenBearer)(value);

/** Decode JSON bodies before any proof lookup or mutation; malformed bodies are never retained. */
export const decodeBody = async <Decoded, Encoded>(
  request: Request,
  schema: Schema.Codec<Decoded, Encoded>
): Promise<Option.Option<Decoded>> => {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
    return Option.none();
  }
  try {
    const bytes = await Effect.runPromise(readBoundedRequestBody(request, policy));
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return Schema.decodeUnknownOption(schema)(value);
  } catch {
    return Option.none();
  }
};
export const scopesFrom = (text: string): Option.Option<typeof PATScopes.Type> => {
  try {
    return Schema.decodeUnknownOption(PATScopes)(JSON.parse(text));
  } catch {
    return Option.none();
  }
};
/** Rebuild decoded persisted fields as a canonical PAT, never spread a D1 row to clients. */
export const patFrom = (row: PATRow): Option.Option<typeof PAT.Type> => {
  const scopes = scopesFrom(row.scopes_json);
  if (Option.isNone(scopes)) return Option.none();
  return Schema.decodeUnknownOption(Schema.toType(PAT))({
    _tag: "PAT",
    id: row.id,
    shortId: row.short_id,
    recipientLabel: row.recipient_label,
    scopes: scopes.value,
    lifetimeDays: row.lifetime_days,
    createdAt: DateTime.makeUnsafe(row.created_at_ms),
    expiresAt: DateTime.makeUnsafe(row.expires_at_ms),
    lastUsedAt: Option.map(Option.fromNullishOr(row.last_used_at_ms), DateTime.makeUnsafe),
    revokedAt: Option.map(Option.fromNullishOr(row.revoked_at_ms), DateTime.makeUnsafe),
  });
};
const cookie = (request: Request): Option.Option<string> => {
  const values =
    request.headers
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .filter((part) => part.startsWith("__Host-fidy_session=")) ?? [];
  if (values.length !== 1) return Option.none();
  const token = values[0]?.slice("__Host-fidy_session=".length) ?? "";
  return /^[A-Za-z0-9_-]{43}$/u.test(token) ? Option.some(token) : Option.none();
};
/** Browser freshness is required for authority changes, but not safe listing. */
export const webSession = async (
  request: Request,
  db: D1Database,
  fresh: boolean
): Promise<Option.Option<SessionRow>> => {
  const token = cookie(request);
  if (Option.isNone(token)) return Option.none();
  const current = currentMillis();
  const row = await db
    .prepare(`SELECT id,user_id FROM web_sessions WHERE token_digest = ?
    AND revoked_at_ms IS NULL AND (? = 0 OR fresh_until_ms > ?) AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?`)
    .bind(await digest(token.value), fresh ? 1 : 0, current, current, current)
    .first();
  return Schema.decodeUnknownOption(SessionRow)(row);
};
/** Recheck the exact WebSession inside a D1 atomic transition, not only on a prior read. */
export const sessionExists = `EXISTS (SELECT 1 FROM web_sessions WHERE id = ? AND user_id = ? AND revoked_at_ms IS NULL
  AND fresh_until_ms > ? AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?)`;
export const sessionParams = (
  session: SessionRow,
  time: number
): readonly [string, string, number, number, number] => [
  session.id,
  session.user_id,
  time,
  time,
  time,
];
export const response = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });
export const canonical = (data: unknown): Response => response({ data, next: [] });
export const unauthorized = (): Response =>
  response(
    {
      error: { code: "unauthenticated", message: "Present a valid credential and retry." },
      next: [],
    },
    httpUnauthorized
  );
export const unavailable = (): Response => response(patPairingUnavailableBody, httpUnavailable);
export const serviceUnavailable = (): Response =>
  response(
    {
      error: {
        code: "unavailable",
        message: "PAT service is temporarily unavailable. Try again later.",
      },
      next: [],
    },
    httpUnavailable
  );
export const invalid = (): Response =>
  response(
    {
      error: {
        code: "pairing_invalid",
        message: "This PAT pairing is no longer valid. Start a new request.",
      },
    },
    httpBadRequest
  );
export const rejected = (): Response =>
  response(
    {
      error: {
        code: "validation_failed",
        message: "This PAT pairing is invalid or no longer available. Start a new request.",
      },
      next: [],
    },
    httpBadRequest
  );
export const notFound = (): Response =>
  response({ error: { code: "not_found", message: "PAT not found." }, next: [] }, httpNotFound);
/** Checks one safe short identifier before it is ever used in a subject-scoped query. */
export const shortIdIsValid = (value: string): boolean => Schema.is(TokenShortId)(value);
