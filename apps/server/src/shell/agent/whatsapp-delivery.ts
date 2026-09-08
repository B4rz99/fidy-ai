import { Context, Effect, Layer } from "effect";
import type { UserId } from "~/core/identity/reference";
import {
  CurrentDeliveryPolicy,
  deliverPreparedReply,
} from "~/shell/channels/whatsapp/reply-delivery";
import { KapsoClient } from "~/shell/channels/whatsapp/kapso-client";
import { SqlClient } from "effect/unstable/sql";
import type { AgentReply } from "./message";
import { Telemetry } from "~/shell/observability/telemetry";

/** Runner-local WhatsApp delivery. Immediate-only runners fail closed if misrouted channel work. */
export const WhatsAppReplyDelivery = Context.Reference<{
  readonly deliver: (userId: UserId, reply: AgentReply) => Effect.Effect<void, "delivery_failed">;
}>("@fidy/server/shell/agent/whatsapp-delivery/WhatsAppReplyDelivery", {
  defaultValue: () => ({
    deliver: (): Effect.Effect<void, "delivery_failed"> => Effect.fail("delivery_failed"),
  }),
});

/** Captures only the real channel adapter's dependencies, never a request-scoped delivery closure. */
export const WhatsAppReplyDeliveryLive = Layer.effect(
  WhatsAppReplyDelivery,
  Effect.gen(function* () {
    const kapso = yield* KapsoClient;
    const sql = yield* SqlClient.SqlClient;
    const policy = yield* CurrentDeliveryPolicy;
    const telemetry = yield* Telemetry;
    return {
      deliver: (userId: UserId, reply: AgentReply): Effect.Effect<void, "delivery_failed"> =>
        deliverPreparedReply({ userId, reply }).pipe(
          Effect.provideService(KapsoClient, kapso),
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(CurrentDeliveryPolicy, policy),
          Effect.provideService(Telemetry, telemetry),
          Effect.asVoid,
          Effect.mapError(() => "delivery_failed" as const)
        ),
    };
  })
);
