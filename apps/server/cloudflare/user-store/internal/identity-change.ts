import { activateWhatsAppIdentity } from "../../identity/operations";
import { activateMailbox } from "../../email-authentication/operations";
import { Clock, Effect, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import {
  IdentityOutcome,
  ReservedIdentity,
  localIdentityCancelUrl,
} from "../../directory/contract";
import { IdentityUnavailable } from "../../identity/contract";

export const applyIdentityChange = Effect.fn(function* (
  request: Request,
  owns: (id: string) => boolean
) {
  const change = yield* Schema.decodeUnknownEffect(ReservedIdentity)(
    yield* Effect.tryPromise(() => request.json())
  );

  if (!owns(change.user_id)) return new Response(null, { status: 503 });
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(ReservedIdentity))(change);

  const context = new Uint8Array(
    yield* Effect.tryPromise(() =>
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded))
    )
  );

  const sql = yield* SqliteClient;

  return yield* Effect.gen(function* () {
    const [prior] =
      yield* sql`SELECT state,context_digest=${context} AS matches FROM identity_change_outcomes WHERE id=${change.id} AND user_id=${change.user_id}`;

    if (prior !== undefined) {
      if (prior.matches !== 1) return new Response(null, { status: 409 });

      return Response.json(yield* Schema.decodeUnknownEffect(IdentityOutcome)(prior.state));
    }

    const now = yield* Clock.currentTimeMillis;
    const timely = request.url !== localIdentityCancelUrl && now < change.expires_at_ms;

    const accepted =
      timely &&
      (yield* change.kind === "whatsapp"
        ? activateWhatsAppIdentity(change)
        : activateMailbox(change));

    const state = accepted ? "committed" : "cancelled";

    const recorded =
      yield* sql`INSERT INTO identity_change_outcomes VALUES(${change.id},${change.user_id},${change.kind},${context},${change.expires_at_ms},${state}) RETURNING 1`;

    if (recorded.length !== 1) return yield* new IdentityUnavailable();

    return Response.json(state);
  }).pipe(withStoreCapacity("required"));
});
