import { Effect } from "effect";
import { MigrationSqlClient } from "~/shell/db/client";

/** Clears channel-owned operational state for integration-test isolation. */
export const truncateWhatsAppChannel = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql`
    TRUNCATE whatsapp_inbound_jobs, whatsapp_turn_claims,
      whatsapp_conversation_windows, whatsapp_message_evidence, whatsapp_ingress_budgets,
      whatsapp_ingress_budget_receipts, whatsapp_inbound_receipts
    CASCADE
  `;
}).pipe(Effect.orDie);
