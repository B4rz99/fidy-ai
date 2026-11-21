import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import { accountingFixture } from "./native-fixture-signer";
import { releaseEvidence } from "./production-release";

const smoke = "fidy-native-smoke-" + accountingFixture.revision;

const queueId = "6f6cc9f41841481dab998e691fc10e61";

const consumerId = "81e6a933e0544e43b38b5583c8ad0faf";

const deadLetterQueue = "fidy-native-async-dead-letters";

const liveQueue = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    queue_id: Schema.Literal(queueId),
    queue_name: Schema.Literal(smoke),
  }),
});

const liveConsumer = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Tuple([
    Schema.Struct({
      consumer_id: Schema.Literal(consumerId),
      script: Schema.optionalKey(Schema.Literal(smoke)),
      script_name: Schema.optionalKey(Schema.Literal(smoke)),
      type: Schema.Literal("worker"),
      dead_letter_queue: Schema.Literal(deadLetterQueue),
      settings: Schema.Struct({
        batch_size: Schema.Literal(1),
        max_retries: Schema.Literal(3),
        max_wait_time_ms: Schema.Literal(0),
        retry_delay: Schema.Literal(0),
      }),
    }).check(Schema.makeFilter((row) => row.script === smoke || row.script_name === smoke)),
  ]),
});

export const confirmInterruptedSmokeConsumer = Effect.gen(function* () {
  const { account, token } = releaseEvidence.config();

  const queueUrl =
    "https://api.cloudflare.com/client/v4/accounts/" + account + "/queues/" + queueId;

  const read = Effect.fn(function* (url: string) {
    return yield* releaseEvidence.providerJson(
      HttpClientRequest.get(url, { headers: { authorization: "Bearer " + token } })
    );
  });

  yield* Schema.decodeUnknownEffect(liveQueue)(yield* read(queueUrl));
  yield* Schema.decodeUnknownEffect(liveConsumer)(yield* read(queueUrl + "/consumers"));
});
