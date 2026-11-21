import { Effect, Option, Schema } from "effect";
import { OutboundHttpRequest } from "../../../src/shell/outbound-http/contract";
import { UnknownJsonString } from "../../../src/shell/schema-codecs/contract";
import { BillingCollectionFailure } from "../contract";
import { WompiSourceId } from "./wompi-model";
import { type WompiTransportFactory } from "./wompi-runtime";

const decode = <A, E>(
  schema: Schema.Codec<A, E>,
  value: unknown
): Effect.Effect<A, BillingCollectionFailure> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) => new BillingCollectionFailure({ cause: Option.some(cause) }))
  );

const Source = Schema.Struct({
  data: Schema.Struct({
    id: WompiSourceId,
    type: Schema.Literal("DAVIPLATA"),
    status: Schema.Literals(["AVAILABLE", "VOIDED"]),
  }),
});

const httpSuccessMinimum = 200;

const httpSuccessMaximum = 300;

export const verifyVoidedSource = Effect.fnUntraced(function* (
  http: Effect.Success<ReturnType<WompiTransportFactory>>,
  sourceId: WompiSourceId
) {
  const response = yield* http
    .execute(OutboundHttpRequest.WompiVerifyPaymentSource({ sourceId }))
    .pipe(Effect.mapError((cause) => new BillingCollectionFailure({ cause: Option.some(cause) })));

  if (response.status < httpSuccessMinimum || response.status >= httpSuccessMaximum) {
    return yield* new BillingCollectionFailure({ cause: Option.none() });
  }

  const body = yield* decode(UnknownJsonString, new TextDecoder().decode(response.body));
  const verified = yield* decode(Source, body);

  if (verified.data.id !== sourceId) {
    return yield* new BillingCollectionFailure({ cause: Option.none() });
  }

  return verified.data.status === "VOIDED";
});
