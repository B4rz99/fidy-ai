import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { Etag, HttpPlatform } from "effect/unstable/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiTest,
} from "effect/unstable/httpapi";
import { ValidationGate, ValidationGateLive } from "./errors";

const CheckedSuccess = Schema.Struct({
  value: Schema.Finite.check(Schema.isGreaterThan(0)),
});

class EncodeFailureApi extends HttpApi.make("encodeFailure")
  .add(
    HttpApiGroup.make("probe").add(
      HttpApiEndpoint.get("read", "/probe", { success: CheckedSuccess })
    )
  )
  .middleware(ValidationGate) {}

const EncodeFailureLive = HttpApiBuilder.group(EncodeFailureApi, "probe", (handlers) =>
  handlers.handle("read", () => Effect.succeed({ value: -1 }))
);

const HttpTestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({}))
);

const EncodeFailureHarness = EncodeFailureLive.pipe(
  Layer.provideMerge(ValidationGateLive),
  Layer.provideMerge(HttpTestServices)
);

layer(EncodeFailureHarness)("validation gate", (it) => {
  it.effect("answers a server success-encode failure as 500 through the derived client", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(EncodeFailureApi, ["probe"]);

      const response = yield* client.probe.read({ responseMode: "response-only" });
      const decodedFailure = yield* Effect.flip(client.probe.read());

      expect(response.status).toBe(500);
      expect(decodedFailure).toMatchObject({ _tag: "HttpClientError" });
    })
  );
});
