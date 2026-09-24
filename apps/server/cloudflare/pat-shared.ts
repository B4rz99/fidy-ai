import {
  PAT,
  PATScopes,
  TokenBearer,
  TokenShortId,
  issuanceWindowMilliseconds,
  maxActivePATs,
  maxIssuancesPerUserWindow,
  pairingMilliseconds,
  patPairingUnavailableBody,
  patShortIdLength,
} from "@fidy/server/tokens-runtime";
import { Clock, Crypto, DateTime, Effect, Encoding, Option, PlatformError, Schema } from "effect";
import { freshSessionExists } from "@fidy/server/identity-runtime";
import { RequestBodyPolicy, readBoundedRequestBody } from "./request-body";
import { browserSession } from "./browser-login";

const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 1024,
  deadlineMilliseconds: 2_000,
});
export { pairingMilliseconds };
export const dayMilliseconds = 86_400_000;
const successStatus = 200;
export const digestBytes = 32;
export { maxActivePATs, issuanceWindowMilliseconds, maxIssuancesPerUserWindow };
export const shortLength = patShortIdLength;
const sampleSize = 16;
export const httpBadRequest = 400;
export const httpUnauthorized = 401;
export const httpNotFound = 404;
export const httpUnavailable = 503;
export const httpConflict = 409;
export const httpTooManyRequests = 429;
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
export const newId = (): string => Effect.runSync(workerCrypto.randomUUIDv4.pipe(Effect.orDie));
export const iso = (milliseconds: number): string =>
  DateTime.formatIso(DateTime.makeUnsafe(milliseconds));
/** Fast SHA-256 is safe here only because inputs are 256-bit randomly generated bearers. */
export const digest = (text: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(text))
    .then((bytes) => new Uint8Array(bytes));
/** Length-checked constant-work comparison for stored and candidate digests. */
export const equalsDigest = ({
  stored,
  candidate,
}: Readonly<{ stored: ReadonlyArray<number>; candidate: Uint8Array }>): boolean => {
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
export const validBearer = (value: string): boolean => Schema.is(TokenBearer)(value);

/** Decode JSON bodies before any proof lookup or mutation; malformed bodies are never retained. */
export const decodeBody = <Decoded, Encoded>({
  request,
  schema,
}: Readonly<{
  request: Request;
  schema: Schema.Codec<Decoded, Encoded>;
}>): Promise<Option.Option<Decoded>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
        return Option.none<Decoded>();
      }
      const bytes = yield* readBoundedRequestBody(request, policy);
      const text = yield* Effect.try(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      const value = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text);
      return Schema.decodeUnknownOption(schema)(value);
    }).pipe(Effect.orElseSucceed(() => Option.none<Decoded>()))
  );
export const scopesFrom = (text: string): Option.Option<PATScopes> => {
  try {
    return Schema.decodeUnknownOption(PATScopes)(JSON.parse(text));
  } catch {
    return Option.none();
  }
};
/** Rebuild decoded persisted fields as a canonical PAT, never spread a D1 row to clients. */
export const patFrom = (row: PATRow): Option.Option<PAT> => {
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
/** Browser freshness is required for authority changes, but not safe listing. */
export const webSession = ({
  request,
  db,
  fresh,
}: Readonly<{ request: Request; db: D1Database; fresh: boolean }>): Promise<
  Option.Option<SessionRow>
> => browserSession({ request, db, input: { current: currentMillis(), fresh } });
/** Recheck the exact WebSession inside a D1 atomic transition, not only on a prior read. */
export const sessionExists = freshSessionExists;
export const response = ({ body, status }: Readonly<{ body: unknown; status: number }>): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });
export const canonical = (data: unknown): Response =>
  response({ body: { data, next: [] }, status: successStatus });
export const unauthorized = (): Response =>
  response({
    body: {
      error: { code: "unauthenticated", message: "Present a valid credential and retry." },
      next: [],
    },
    status: httpUnauthorized,
  });
export const unavailable = (): Response =>
  response({ body: patPairingUnavailableBody, status: httpUnavailable });
export const serviceUnavailable = (): Response =>
  response({
    body: {
      error: {
        code: "unavailable",
        message: "PAT service is temporarily unavailable. Try again later.",
      },
      next: [],
    },
    status: httpUnavailable,
  });
export const invalid = (): Response =>
  response({
    body: {
      error: {
        code: "pairing_invalid",
        message: "This PAT pairing is no longer valid. Start a new request.",
      },
    },
    status: httpBadRequest,
  });
export const rejected = (): Response =>
  response({
    body: {
      error: {
        code: "validation_failed",
        message: "This PAT pairing is invalid or no longer available. Start a new request.",
      },
      next: [],
    },
    status: httpBadRequest,
  });
export const notFound = (): Response =>
  response({
    body: { error: { code: "not_found", message: "PAT not found." }, next: [] },
    status: httpNotFound,
  });
/** Checks one safe short identifier before it is ever used in a subject-scoped query. */
export const shortIdIsValid = (value: string): boolean => Schema.is(TokenShortId)(value);
