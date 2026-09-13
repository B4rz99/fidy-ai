import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe } from "vitest";
import {
  WhatsAppInboundWork,
  whatsappInboundQueueId,
  whatsappInboundQueueName,
} from "~/shell/channels/whatsapp/inbound-execution";
import {
  StatementIngestionPayload,
  statementIngestionQueueId,
  statementIngestionQueueName,
} from "~/shell/ingestion/worker";
import {
  assertStandaloneDurableQueueFixture,
  durableQueueSpec,
  loadStandaloneDurableQueueFixture,
} from "~/shell/testing/durable-compatibility";

const specs = [
  durableQueueSpec({
    key: "statement-ingestion",
    name: statementIngestionQueueName,
    schema: StatementIngestionPayload,
    queueId: (payload) => Effect.succeed(statementIngestionQueueId(payload)),
  }),
  durableQueueSpec({
    key: "whatsapp-inbound-turn",
    name: whatsappInboundQueueName,
    schema: WhatsAppInboundWork,
    queueId: (payload) => Effect.succeed(whatsappInboundQueueId(payload)),
  }),
];

describe("standalone durable queue compatibility", () => {
  it.effect("decodes every checked-in payload and preserves its queue identity", () =>
    assertStandaloneDurableQueueFixture(loadStandaloneDurableQueueFixture(), specs)
  );
});
