import { digestBytes } from "../../secret-material/operations";
import { Hex } from "effect/encoding";
import { Clock, Effect, Option, Schema } from "effect";
import { chargeBootstrapWindows } from "./admission";
import {
  ExternalEventKey,
  ExternalEventRoute,
  StatusLookupCoordinates,
  currentRouteReservation,
  externalReserveUrl,
  statusLookupAdmissionUrl,
} from "../contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { withStoreAdmission } from "../../runtime/sqlite/operations";

const noContentStatus = 204;

const missingRouteStatus = 404;

const conflictStatus = 409;

export const externalEventRequest = Effect.fn(function* (request: Request) {
  if (request.url === statusLookupAdmissionUrl) return yield* admitKapsoLookup(request);
  const sql = yield* SqliteClient;
  const body: unknown = yield* Effect.tryPromise(() => request.json());
  const key = yield* Schema.decodeUnknownEffect(ExternalEventKey)(body);

  if (request.url === externalReserveUrl) {
    const route = yield* Schema.decodeUnknownEffect(ExternalEventRoute)(body);

    return yield* withStoreAdmission((growth) =>
      Effect.gen(function* () {
        if (!currentRouteReservation({ request, now: yield* Clock.currentTimeMillis })) {
          return new Response(null, { status: conflictStatus });
        }

        if ((yield* sql`SELECT 1 FROM erasure_barriers WHERE user_id=${route.userId}`).length > 0) {
          return new Response(null, { status: conflictStatus });
        }

        const [existing] =
          yield* sql`SELECT user_id,operation_id,family FROM external_event_routes WHERE kind=${key.kind} AND endpoint=${key.endpoint} AND lookup=${key.lookup}`;

        if (existing !== undefined) {
          const exact =
            existing.user_id === route.userId &&
            existing.operation_id === route.operationId &&
            existing.family === route.family;

          return new Response(null, { status: exact ? noContentStatus : conflictStatus });
        }

        yield* growth;

        const inserted =
          yield* sql`INSERT INTO external_event_routes(kind,endpoint,lookup,user_id,operation_id,family) VALUES(${key.kind},${key.endpoint},${key.lookup},${route.userId},${route.operationId},${route.family}) ON CONFLICT DO NOTHING RETURNING 1`;

        return new Response(null, {
          status: inserted.length === 1 ? noContentStatus : conflictStatus,
        });
      })
    );
  }

  const [row] =
    yield* sql`SELECT kind,endpoint,lookup,user_id AS userId,operation_id AS operationId,family FROM external_event_routes WHERE kind=${key.kind} AND endpoint=${key.endpoint} AND lookup=${key.lookup}`;

  return row === undefined
    ? new Response(null, { status: missingRouteStatus })
    : Response.json(yield* Schema.decodeUnknownEffect(ExternalEventRoute)(row));
});

const sourceCooldownMs = 60000;

const sharedBudget = 500;

const lookupPeriodMs = 3600000;

const admitKapsoLookup = Effect.fn(function* (request: Request) {
  const coordinates = yield* Schema.decodeUnknownEffect(StatusLookupCoordinates)(
    yield* Effect.tryPromise(() => request.json())
  );

  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(StatusLookupCoordinates))(
    coordinates
  );

  const scope = Hex.encode(yield* digestBytes(new TextEncoder().encode(encoded)));

  const limited = yield* chargeBootstrapWindows([
    { scope: "kapso-status:" + scope, limit: 1, duration: sourceCooldownMs },
    { scope: "kapso-status-total", limit: sharedBudget, duration: lookupPeriodMs },
  ]);

  return Option.getOrElse(limited, () => new Response(null, { status: noContentStatus }));
});
