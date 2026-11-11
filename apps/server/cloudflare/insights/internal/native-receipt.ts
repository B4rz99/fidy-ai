import { type OwnedStatement } from "../../../src/shell/owner-write/contract";
import { preparePredicateCheck } from "../../../src/shell/sql-assertions/operations";

/** Check correlated receipt rows with retained delivery_* and native send_started_at_ms/provider_message_id fields. */
export const prepareNativeReceiptAgreement = ({
  db,
  receipts,
}: Readonly<{ db: D1Database; receipts: OwnedStatement }>): D1PreparedStatement =>
  preparePredicateCheck({
    db,
    scope: "insight_mutation",
    predicate: {
      sql: `SELECT 1 WHERE NOT EXISTS (
        SELECT 1 FROM (${receipts.sql}) AS receipt WHERE delivery_receipt_id IS NOT NULL
          AND NOT (delivery_sent_at_ms IS send_started_at_ms
            AND delivery_channel IS 'whatsapp' AND delivery_provider IS 'kapso'
            AND delivery_provider_message_id IS provider_message_id))`,
      params: receipts.params,
    },
  });
