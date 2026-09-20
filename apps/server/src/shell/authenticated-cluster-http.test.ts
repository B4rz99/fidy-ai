import { expect, it, layer } from "@effect/vitest";
import { Context, Data, Effect, Layer, Redacted, Ref, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { RpcMessage, RpcSerialization } from "effect/unstable/rpc";
import { expectNotInspected } from "~/shell/testing/credential-failure";
import {
  ClusterSerializationLive,
  authenticatedRunnerMiddleware,
} from "./authenticated-cluster-http";
import { clusterSerializationMaxBufferSizeBytes } from "./cluster-topology";

const tokenFixture = "f1d7c0de".repeat(8);
const token = Redacted.make(tokenFixture);
const clusterPath = "/_fidy/cluster";
type RunnerHandler = (request: Request) => Promise<Response>;
/** Curried so each test binds one method and then spells only the path and headers it exercises. */
const request =
  (handler: RunnerHandler, method: string) =>
  (path: string, headers: Readonly<Record<string, string>> = {}): Effect.Effect<Response> =>
    Effect.promise(() => handler(new Request(`http://runner${path}`, { method, headers })));
const releaseHandler = (dispose: () => Promise<void>): Effect.Effect<void> =>
  Effect.promise(dispose);
const responseText = (response: Response): Effect.Effect<string> =>
  Effect.promise(() => response.text());

/** Thrown SchemaBinary parser failures kept typed so assertions can inspect the actual cause. */
class SchemaBinaryDecodeFailure extends Data.TaggedError("SchemaBinaryDecodeFailure")<{
  readonly error: unknown;
}> {}

/** The production serialization's parser, resolved from the layer under test. */
const parserUnderTest = Effect.gen(function* () {
  const serialization = yield* RpcSerialization.RpcSerialization;
  return serialization.makeUnsafe();
});
const encodedBytes = (parser: RpcSerialization.Parser, value: unknown): Effect.Effect<Uint8Array> =>
  Effect.suspend(() => {
    const encoded = parser.encode(value);
    return encoded instanceof Uint8Array
      ? Effect.succeed(encoded)
      : Effect.die("SchemaBinary must encode a frame as bytes");
  });
const decodeFailure = (
  parser: RpcSerialization.Parser,
  bytes: Uint8Array
): Effect.Effect<SchemaBinaryDecodeFailure, ReadonlyArray<unknown>> =>
  Effect.try({
    try: () => parser.decode(bytes),
    catch: (error) => new SchemaBinaryDecodeFailure({ error }),
  }).pipe(Effect.flip);

const oversizedRequest = {
  _tag: "Request",
  id: "oversized",
  tag: "Probe",
  payload: new Uint8Array(clusterSerializationMaxBufferSizeBytes),
  headers: [],
} as const;

const encodeOversizedRequest = Effect.gen(function* () {
  const context = yield* Layer.build(
    RpcSerialization.layerSchemaBinary({ maxFrameSize: "unbounded" })
  );
  const serialization = Context.get(context, RpcSerialization.RpcSerialization);
  return yield* encodedBytes(serialization.makeUnsafe(), oversizedRequest);
}).pipe(Effect.scoped);

layer(ClusterSerializationLive)("Cluster runner SchemaBinary framing", (it) => {
  it("pins the configured retained-frame bound", () => {
    // The reviewed 64 KiB bound; changing it must be a deliberate, reviewed protocol decision.
    expect(clusterSerializationMaxBufferSizeBytes).toBe(64 * 1024);
  });

  it.effect("rejects malformed SchemaBinary input and spends the parser", () =>
    Effect.gen(function* () {
      const parser = yield* parserUnderTest;
      expect(() => parser.decode(new Uint8Array([1, 0xff]))).toThrow();
      expect(() => parser.decode(new Uint8Array())).toThrow(/parser is spent/);
    })
  );

  it.effect("retains an incomplete SchemaBinary frame until it is completed", () =>
    Effect.gen(function* () {
      const parser = yield* parserUnderTest;
      const encoded = yield* encodedBytes(parser, RpcMessage.constPing);
      expect(parser.decode(encoded.subarray(0, encoded.length - 1))).toEqual([]);
      expect(parser.decode(encoded.subarray(encoded.length - 1))).toEqual([RpcMessage.constPing]);
    })
  );

  it.effect("rejects a declared frame beyond the configured SchemaBinary bound", () =>
    Effect.gen(function* () {
      const parser = yield* parserUnderTest;
      const ping = yield* encodedBytes(parser, RpcMessage.constPing);
      const encoded = yield* encodeOversizedRequest;
      const failure = yield* decodeFailure(parser, encoded.subarray(0, 32));
      expect(Schema.isSchemaError(failure.error)).toBe(true);
      expect(() => parser.decode(ping)).toThrow(/parser is spent/);
    })
  );
});

it.effect("keeps Cluster credentials out of authentication failures", () =>
  Effect.gen(function* () {
    const invocations = yield* Ref.make(0);
    const routes = HttpRouter.use((router) =>
      router.add(
        "POST",
        clusterPath,
        Ref.update(invocations, (count) => count + 1).pipe(
          Effect.as(HttpServerResponse.text("accepted"))
        )
      )
    );

    yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(Layer.mergeAll(authenticatedRunnerMiddleware(token), routes), {
          disableLogger: true,
        })
      ),
      ({ handler }) =>
        Effect.gen(function* () {
          const post = request(handler, "POST");
          const get = request(handler, "GET");
          const rejected = yield* Effect.all([
            post(clusterPath),
            post(clusterPath, { authorization: Redacted.value(token) }),
            post(clusterPath, { authorization: `Bearer ${"b".repeat(64)}` }),
            // The router matches these spellings of the same route, so the guard cannot rely on
            // the exact path before authenticating.
            post(`${clusterPath}/`),
            post(`/${clusterPath}`),
            post("/_FIDY/CLUSTER"),
            get("/health"),
          ]);
          for (const response of rejected) {
            expect(response.status).toBe(401);
            expect(yield* responseText(response)).toBe("");
          }
          expect(yield* Ref.get(invocations)).toBe(0);

          expectNotInspected(token, tokenFixture);
          expectNotInspected(authenticatedRunnerMiddleware(token), tokenFixture);

          const accepted = yield* post(clusterPath, {
            authorization: `Bearer ${Redacted.value(token)}`,
          });
          expect(accepted.status).toBe(200);
          expect(yield* responseText(accepted)).toBe("accepted");
          expect(yield* Ref.get(invocations)).toBe(1);

          // Valid credentials still cannot reach a route this listener does not serve.
          const unknown = yield* get("/health", {
            authorization: `Bearer ${Redacted.value(token)}`,
          });
          expect(unknown.status).toBe(404);
        }),
      ({ dispose }) => releaseHandler(dispose)
    );
  })
);
