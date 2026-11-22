import { Clock, Effect, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import {
  FrozenChannelApproval,
  type WhatsAppBootstrapText,
  localChannelApprovalUrl,
} from "../contract";
import { newId } from "../../secret-material/operations";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import { invalidPairing } from "../../browser-login/operations";
import { UserId } from "../../../src/core/identity/contract";

const isResponse = Schema.is(Schema.instanceOf(Response));

export const channelApprovalEvidence = Effect.fn(function* (id: string) {
  const sql = yield* SqliteClient;

  const [record] =
    yield* sql`SELECT a.id,a.user_id,a.pairing_id,a.portfolio,a.bsuid,a.endpoint,a.message,a.occurred_ms,a.received_ms,p.ordinal,p.verifier_digest,p.last_poll_ms,p.minimum_poll_seconds,p.expires_at_ms,p.wrong_attempts FROM channel_approvals a JOIN browser_pairings p ON p.id=a.pairing_id AND p.user_id=a.user_id WHERE a.id=${id}`;

  return yield* Schema.decodeUnknownEffect(Schema.NullOr(FrozenChannelApproval))(record ?? null);
});

export const approveChannelPairing = Effect.fn(function* (
  event: typeof WhatsAppBootstrapText.Type,
  code: string,
  users: Pick<DurableObjectNamespace, "getByName">
) {
  const sql = yield* SqliteClient;

  const result = yield* Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;

    const [route] =
      yield* sql`SELECT user_id FROM whatsapp_routes WHERE portfolio=${event.portfolio} AND bsuid=${event.bsuid} AND established=1`;

    if (route === undefined) return invalidPairing();
    const user = yield* Schema.decodeUnknownEffect(UserId)(route.user_id);

    const [old] =
      yield* sql`SELECT a.id FROM channel_approvals a JOIN browser_pairings p ON p.id=a.pairing_id WHERE a.user_id=${user} AND a.portfolio=${event.portfolio} AND a.bsuid=${event.bsuid} AND a.endpoint=${event.endpoint} AND a.message=${event.message} AND p.public_code=${code}`;

    if (old !== undefined) {
      return { id: yield* Schema.decodeUnknownEffect(Schema.String)(old.id), user };
    }

    const [pairing] =
      yield* sql`SELECT id FROM browser_pairings WHERE public_code=${code} AND user_id IS NULL AND wrong_attempts<5 AND expires_at_ms>${current} AND expires_at_ms>${event.occurredAt} AND ((expires_at_ms-600000)/1000)*1000<=${event.occurredAt}`;

    if (pairing === undefined) return invalidPairing();
    const id = newId();
    yield* sql`INSERT INTO channel_approvals(id,pairing_id,user_id,portfolio,bsuid,endpoint,message,occurred_ms,received_ms) VALUES(${id},${pairing.id},${user},${event.portfolio},${event.bsuid},${event.endpoint},${event.message},${event.occurredAt},${event.receivedAt})`;
    yield* sql`UPDATE browser_pairings SET user_id=${user} WHERE id=${pairing.id}`;

    return { id, user };
  }).pipe(withStoreCapacity("growth"));

  if (isResponse(result)) return result;

  return yield* Effect.tryPromise((signal) =>
    users
      .getByName(result.user)
      .fetch(localChannelApprovalUrl, { method: "POST", body: result.id, signal })
  );
});
