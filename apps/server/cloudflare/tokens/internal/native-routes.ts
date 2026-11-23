import { PATUnavailable, nativePATDirectoryUrl } from "../contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Option, Schema } from "effect";
import { UserId } from "../../../src/core/identity/contract";
import {
  PATId,
  PATLifetimeDays,
  PATPairingId,
  PATPairingPublicCodeInput,
  PATRecipientLabel,
  PATScopes,
  TokenShortId,
} from "../../../src/core/tokens/contract";
import {
  currentRouteReservation,
  directoryName,
  routeIssuedHeader,
} from "../../directory/contract";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import { newId } from "../../secret-material/operations";
import { newShortId } from "./pat-shared";

const digestHex = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));

const Lookup = Schema.Struct({
  kind: Schema.Literal("review"),
  code: PATPairingPublicCodeInput,
  user: UserId,
});

const Bind = Schema.Struct({ kind: Schema.Literal("bind"), pairing: PATPairingId, user: UserId });

const Reserve = Schema.Struct({
  kind: Schema.Literal("reserve"),
  user: UserId,
  operation: Schema.String,
  context: digestHex,
  expires: Schema.Int,
});

export const FrozenPAT = Schema.Struct({
  id: PATPairingId,
  recipient_label: PATRecipientLabel,
  scopes_json: Schema.fromJsonString(PATScopes),
  lifetime_days: PATLifetimeDays,
  expires_at_ms: Schema.Int,
  public_code: Schema.String,
  proof_digest: digestHex,
  wrong_attempts: Schema.Int,
  last_poll_at_ms: Schema.NullOr(Schema.Int),
  minimum_poll_seconds: Schema.Int,
});

export const Reservation = Schema.Struct({
  short_id: TokenShortId,
  pat_id: PATId,
  expires_at_ms: Schema.Int,
});

type Command = typeof Lookup.Type | typeof Bind.Type | typeof Reserve.Type;

export type Directory = Pick<DurableObjectNamespace, "getByName">;

const absentRecord = 404;

const maximumOutstandingPATReservations = 12;

const withinReservationBound = Effect.fn(function* (
  user: UserId,
  operation: string,
  current: number
) {
  const sql = yield* SqliteClient;

  const prior =
    yield* sql`SELECT 1 FROM pat_routes WHERE user_id=${user} AND reservation_id=${operation} AND expires_at_ms>${current}`;

  if (prior.length > 0) return true;

  const [outstanding] =
    yield* sql`SELECT count(*) AS n FROM pat_routes WHERE user_id=${user} AND expires_at_ms>${current}`;

  return Number(outstanding?.n ?? 0) < maximumOutstandingPATReservations;
});

export const directoryEvidence = Effect.fn(function* <A, Encoded>(
  directory: Directory,
  input: Command,
  schema: Schema.Codec<A, Encoded>
) {
  const issuedAt = yield* Clock.currentTimeMillis;
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(input);

  const response = yield* Effect.tryPromise((signal) =>
    directory.getByName(directoryName).fetch(nativePATDirectoryUrl, {
      method: "POST",
      headers: { [routeIssuedHeader]: String(issuedAt) },
      body,
      signal,
    })
  );

  if (response.status === absentRecord) return Option.none<A>();

  if (!response.ok) return yield* new PATUnavailable({ cause: Option.none() });

  return Option.some(
    yield* Schema.decodeUnknownEffect(schema)(yield* Effect.tryPromise(() => response.json()))
  );
});

const reservePATRoute = Effect.fn(function* (
  request: Request,
  input: typeof Reserve.Type,
  current: number
) {
  if (input.expires <= current || !currentRouteReservation({ request, now: current })) {
    return new Response(null, { status: absentRecord });
  }

  if (!(yield* withinReservationBound(input.user, input.operation, current))) {
    return new Response(null, { status: absentRecord });
  }

  const sql = yield* SqliteClient;

  const shortId = newShortId(),
    patId = newId();

  yield* sql`INSERT INTO pat_routes(short_id,user_id,pat_id,reservation_id,expires_at_ms) VALUES(${shortId},${input.user},${patId},${input.operation},${input.expires}) ON CONFLICT DO NOTHING`;
  yield* sql`INSERT INTO pat_reservation_context(short_id,context) SELECT short_id,${input.context} FROM pat_routes WHERE short_id=${shortId} AND pat_id=${patId} AND user_id=${input.user} AND reservation_id=${input.operation} ON CONFLICT DO NOTHING`;

  const [row] =
    yield* sql`SELECT r.short_id,r.pat_id,r.expires_at_ms FROM pat_routes r JOIN pat_reservation_context c USING(short_id) WHERE r.user_id=${input.user} AND r.reservation_id=${input.operation} AND c.context=${input.context} AND r.expires_at_ms>${current}`;

  return row === undefined ? new Response(null, { status: absentRecord }) : Response.json(row);
});

export const directoryPATCommand = Effect.fn(function* (request: Request) {
  const input = yield* Schema.decodeUnknownEffect(Schema.Union([Lookup, Bind, Reserve]))(
    yield* Effect.tryPromise(() => request.json())
  );

  const sql = yield* SqliteClient;

  return yield* Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;

    if (input.kind === "reserve") {
      return yield* reservePATRoute(request, input, current);
    }

    if (input.kind === "bind") {
      yield* sql`UPDATE pat_bootstrap SET user_id=${input.user} WHERE id=${input.pairing} AND user_id IS NULL AND expires_at_ms>${current}`;
    }

    const [row] =
      input.kind === "bind"
        ? yield* sql`SELECT * FROM pat_bootstrap WHERE id=${input.pairing} AND user_id=${input.user} AND NOT EXISTS(SELECT 1 FROM erasure_barriers WHERE user_id=${input.user}) AND expires_at_ms>${current}`
        : yield* sql`SELECT * FROM pat_bootstrap WHERE public_code=${input.code} AND NOT EXISTS(SELECT 1 FROM erasure_barriers WHERE user_id=${input.user}) AND expires_at_ms>${current} AND (user_id IS NULL OR user_id=${input.user})`;

    return row === undefined ? new Response(null, { status: 404 }) : Response.json(row);
  }).pipe(withStoreCapacity(input.kind === "review" ? "required" : "growth"));
});
