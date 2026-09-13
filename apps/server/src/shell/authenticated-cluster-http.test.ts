import { expect, it, layer } from "@effect/vitest";
import { Data, Effect, Layer, Redacted, Ref } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization } from "effect/unstable/rpc";
import { expectNotInspected } from "~/shell/testing/credential-failure";
import {
  ClusterRunnerSerializationLive,
  authenticatedRunnerMiddleware,
  maximumClusterMessageBufferBytes,
} from "./authenticated-cluster-http";

const tokenFixture = "f1d7c0de".repeat(8);
const token = Redacted.make(tokenFixture);
type RunnerHandler = (request: Request) => Promise<Response>;
const post = (
  handler: RunnerHandler,
  headers: Readonly<Record<string, string>> = {}
): Effect.Effect<Response> =>
  Effect.promise(() =>
    handler(new Request("http://runner/_fidy/cluster", { method: "POST", headers }))
  );
const get = (handler: RunnerHandler, path: string): Effect.Effect<Response> =>
  Effect.promise(() => handler(new Request(`http://runner${path}`)));
const releaseHandler = (dispose: () => Promise<void>): Effect.Effect<void> =>
  Effect.promise(dispose);
const responseText = (response: Response): Effect.Effect<string> =>
  Effect.promise(() => response.text());

/** Thrown MessagePack parser failures kept typed so assertions can inspect the actual cause. */
class MessagePackDecodeFailure extends Data.TaggedError("MessagePackDecodeFailure")<{
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
      : Effect.die("MessagePack must encode a frame as bytes");
  });
const decodeFailure = (
  parser: RpcSerialization.Parser,
  bytes: Uint8Array
): Effect.Effect<MessagePackDecodeFailure, ReadonlyArray<unknown>> =>
  Effect.try({
    try: () => parser.decode(bytes),
    catch: (error) => new MessagePackDecodeFailure({ error }),
  }).pipe(Effect.flip);

/** A valid MessagePack prefix that declares far more array elements than it carries. */
const declaredOversizeFrame = (bytes: number): Uint8Array => {
  const frame = new Uint8Array(bytes);
  frame.set([0xdd, 0xff, 0xff, 0xff, 0xff]);
  return frame;
};

layer(ClusterRunnerSerializationLive)("Cluster runner MessagePack framing", (it) => {
  it("pins the configured retained-frame bound", () => {
    // The reviewed 64 KiB bound; changing it must be a deliberate, reviewed protocol decision.
    expect(maximumClusterMessageBufferBytes).toBe(64 * 1024);
  });

  it.effect("rejects malformed MessagePack frames without retaining a partial prefix", () =>
    Effect.gen(function* () {
      const parser = yield* parserUnderTest;
      // A fixext1 carrying an unregistered extension type: a well-formed header msgpackr cannot accept.
      const failure = yield* decodeFailure(parser, new Uint8Array([0xd4, 0x7f, 0x00]));
      expect(failure.error).toBeInstanceOf(Error);
      expect(failure.error).not.toBeInstanceOf(RpcSerialization.MaxBufferSizeExceeded);
      const encoded = yield* encodedBytes(parser, { accepted: true });
      expect(parser.decode(encoded)).toEqual([{ accepted: true }]);
    })
  );

  it.effect("retains an incomplete MessagePack frame until it is completed", () =>
    Effect.gen(function* () {
      const parser = yield* parserUnderTest;
      const encoded = yield* encodedBytes(parser, { fragment: "complete" });
      expect(parser.decode(encoded.subarray(0, encoded.length - 1))).toEqual([]);
      expect(parser.decode(encoded.subarray(encoded.length - 1))).toEqual([
        { fragment: "complete" },
      ]);
    })
  );

  it.effect(
    "fails an incomplete frame that grows beyond the configured MessagePack buffer bound",
    () =>
      Effect.gen(function* () {
        const parser = yield* parserUnderTest;
        expect(parser.decode(declaredOversizeFrame(maximumClusterMessageBufferBytes))).toEqual([]);
        const failure = yield* decodeFailure(parser, new Uint8Array([0x00]));
        if (!(failure.error instanceof RpcSerialization.MaxBufferSizeExceeded)) {
          return yield* Effect.die("expected MaxBufferSizeExceeded");
        }
        expect(failure.error.maxBufferSize).toBe(maximumClusterMessageBufferBytes);
        const encoded = yield* encodedBytes(parser, { recovered: true });
        expect(parser.decode(encoded)).toEqual([{ recovered: true }]);
      })
  );

  it.effect(
    "fails a single incomplete chunk that exceeds the configured MessagePack buffer bound",
    () =>
      Effect.gen(function* () {
        const parser = yield* parserUnderTest;
        const failure = yield* decodeFailure(
          parser,
          declaredOversizeFrame(maximumClusterMessageBufferBytes + 1)
        );
        if (!(failure.error instanceof RpcSerialization.MaxBufferSizeExceeded)) {
          return yield* Effect.die("expected MaxBufferSizeExceeded");
        }
        expect(failure.error.maxBufferSize).toBe(maximumClusterMessageBufferBytes);
      })
  );
});

it.effect("keeps Cluster credentials out of authentication failures", () =>
  Effect.gen(function* () {
    const invocations = yield* Ref.make(0);
    const routes = HttpRouter.use((router) =>
      router.add(
        "POST",
        "/_fidy/cluster",
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
          const missing = yield* post(handler);
          const malformed = yield* post(handler, { authorization: Redacted.value(token) });
          const incorrect = yield* post(handler, {
            authorization: `Bearer ${"b".repeat(64)}`,
          });

          expect(missing.status).toBe(401);
          expect(malformed.status).toBe(401);
          expect(incorrect.status).toBe(401);
          expect(yield* responseText(missing)).toBe("");
          expect(yield* responseText(malformed)).toBe("");
          expect(yield* responseText(incorrect)).toBe("");
          expect(yield* Ref.get(invocations)).toBe(0);

          expectNotInspected(token, tokenFixture);
          expectNotInspected(authenticatedRunnerMiddleware(token), tokenFixture);

          const accepted = yield* post(handler, {
            authorization: `Bearer ${Redacted.value(token)}`,
          });
          expect(accepted.status).toBe(200);
          expect(yield* responseText(accepted)).toBe("accepted");
          expect(yield* Ref.get(invocations)).toBe(1);

          const publicResponse = yield* get(handler, "/health");
          expect(publicResponse.status).toBe(404);
        }),
      ({ dispose }) => releaseHandler(dispose)
    );
  })
);
