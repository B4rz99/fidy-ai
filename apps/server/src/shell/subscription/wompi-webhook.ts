import { DateTime, Effect, Option, Result, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { UnknownJsonString } from "~/schema-compatibility";
import { collectBoundedBytes } from "~/shell/_shared/bounded-bytes";
import { receiveWompiSettlement } from "./wompi-settlement";

const maximumWompiEventBytes = 32_768;
const decodeJson = Schema.decodeUnknownResult(UnknownJsonString);

/** Public authenticated Wompi event ingress; all settlement authority remains in the deep service. */
export const WompiWebhookLive = HttpRouter.add("POST", "/webhooks/wompi", (request) =>
  Effect.gen(function* () {
    const exactBody = yield* collectBoundedBytes(request.stream, maximumWompiEventBytes);
    if (Option.isNone(exactBody)) return HttpServerResponse.empty({ status: 413 });
    const payload = decodeJson(new TextDecoder().decode(exactBody.value));
    if (Result.isFailure(payload)) return HttpServerResponse.empty({ status: 400 });
    yield* receiveWompiSettlement({ payload: payload.success, observedAt: yield* DateTime.now });
    return HttpServerResponse.empty({ status: 202 });
  }).pipe(
    Effect.catchTags({
      InvalidWompiEvent: () => Effect.succeed(HttpServerResponse.empty({ status: 401 })),
      MismatchedWompiEvidence: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
      WompiSettlementUnavailable: () => Effect.succeed(HttpServerResponse.empty({ status: 503 })),
    })
  )
);
