import {
  PAT,
  PATScopes,
  patBearerPrefix,
  patShortIdLength,
} from "../../../src/core/tokens/contract";
import {
  issuanceWindowMilliseconds,
  maxActivePATs,
  maxIssuancesPerUserWindow,
  pairingMilliseconds,
} from "../../../src/shell/tokens/operations";
import { patPairingUnavailableBody } from "../../../src/shell/tokens/contract";
import { DateTime, Effect, Option, Schema, Struct } from "effect";
import { Base64Url } from "effect/encoding";
import { RequestBodyPolicy } from "../../http/contract";
import { readBoundedRequestBody } from "../../http/operations";

const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 1024,
  deadlineMilliseconds: 2_000,
});

export { pairingMilliseconds };

export const dayMilliseconds = 86_400_000;

export const digestBytes = 32;

export { maxActivePATs, issuanceWindowMilliseconds, maxIssuancesPerUserWindow };

export const shortLength = patShortIdLength;

const sampleSize = 16;

export const pairingRejectedMessage =
  "This PAT pairing is invalid or no longer available. Start a new request.";

export const httpBadRequest = 400;

export const httpUnavailable = 503;

export const httpRateLimited = 429;

export const pairingRateLimitedSeconds = 60;

export const pairingRateLimitedBody = {
  error: {
    code: "rate_limited",
    message: pairingRejectedMessage,
    retryAfterSeconds: pairingRateLimitedSeconds,
  },
  next: [],
} as const;

const unbiasedBase36Limit = 252;

const shortAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789";

export const SessionRow = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  user_id: Schema.String.check(Schema.isUUID()),
});

export type SessionRow = typeof SessionRow.Type;

export const retainedPATMillis = Schema.Finite.check(
  Schema.isInt(),
  Schema.makeFilter((milliseconds) =>
    Option.exists(DateTime.make(milliseconds), Schema.is(Schema.toType(PAT.fields.createdAt)))
      ? undefined
      : "Expected a canonical PAT timestamp"
  )
);

export const PATRow = Schema.Struct({
  id: Schema.String,
  user_id: Schema.String,
  short_id: Schema.String,
  recipient_label: Schema.String,
  scopes_json: Schema.String,
  lifetime_days: Schema.Int,
  created_at_ms: retainedPATMillis,
  expires_at_ms: retainedPATMillis,
  last_used_at_ms: Schema.NullOr(retainedPATMillis),
  revoked_at_ms: Schema.NullOr(retainedPATMillis),
});

export type PATRow = typeof PATRow.Type;

export const iso = (milliseconds: number): string =>
  DateTime.formatIso(DateTime.makeUnsafe(milliseconds));

export const digest = (text: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(text))
    .then((bytes) => new Uint8Array(bytes));

export const newProof = (): string =>
  Base64Url.encode(crypto.getRandomValues(new Uint8Array(digestBytes)));

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

export const newBearer = (shortId: string): string => `${patBearerPrefix}${shortId}_${newProof()}`;

export const decodeBody = <Decoded, Encoded>({
  request,
  schema,
}: Readonly<{
  request: Request;
  schema: Schema.Codec<Decoded, Encoded>;
}>): Effect.Effect<Option.Option<Decoded>> =>
  Effect.gen(function* () {
    if (
      request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json"
    ) {
      return Option.none<Decoded>();
    }

    const bytes = yield* readBoundedRequestBody(request, policy);
    const text = yield* Effect.try(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const value = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text);

    return Schema.decodeUnknownOption(schema)(value);
  }).pipe(
    Effect.tapError(Effect.logDebug),
    Effect.orElseSucceed(() => Option.none<Decoded>())
  );

export const scopesFrom = (text: string): Option.Option<PATScopes> =>
  Schema.decodeOption(Schema.fromJsonString(PATScopes))(text);

const PATFields = Schema.toType(PAT.mapFields(Struct.omit(["_tag"])));

export const patFrom = (row: PATRow): Option.Option<PAT> => {
  const scopes = scopesFrom(row.scopes_json);

  if (Option.isNone(scopes)) return Option.none();

  return Schema.decodeUnknownOption(PATFields)({
    id: row.id,
    shortId: row.short_id,
    recipientLabel: row.recipient_label,
    scopes: scopes.value,
    lifetimeDays: row.lifetime_days,
    createdAt: DateTime.makeUnsafe(row.created_at_ms),
    expiresAt: DateTime.makeUnsafe(row.expires_at_ms),
    lastUsedAt: Option.map(Option.fromNullishOr(row.last_used_at_ms), DateTime.makeUnsafe),
    revokedAt: Option.map(Option.fromNullishOr(row.revoked_at_ms), DateTime.makeUnsafe),
  }).pipe(Option.map((fields) => PAT.make(fields)));
};

export const response = ({ body, status }: Readonly<{ body: unknown; status: number }>): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

export const unavailable = (): Response =>
  response({ body: patPairingUnavailableBody, status: httpUnavailable });

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
