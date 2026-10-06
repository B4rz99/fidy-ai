import { it } from "@effect/vitest";
import { Data, Effect, Option, Schema } from "effect";
import { afterEach, describe, expect, vi } from "vitest";
import { heapUsage, profileWorkerRequest } from "./workerd-inspector";

class InspectorTestError extends Data.TaggedError("InspectorTestError")<{
  readonly cause: unknown;
}> {}

type SocketData = { readonly proof: true };
const servers: Array<Bun.Server<SocketData>> = [];

const serveInspector = (
  onMessage: (socket: Bun.ServerWebSocket<SocketData>, message: string) => void,
  onClose: () => void = () => undefined
): string => {
  const server = Bun.serve<SocketData>({
    port: 0,
    fetch(request, server) {
      return server.upgrade(request, { data: { proof: true } })
        ? undefined
        : new Response("upgrade required", { status: 426 });
    },
    websocket: {
      message(socket, message) {
        onMessage(socket, String(message));
      },
      close: onClose,
    },
  });
  servers.push(server);
  return `ws://127.0.0.1:${server.port}`;
};

const Command = Schema.fromJsonString(Schema.Struct({ id: Schema.Finite }));

const acknowledgeStart = (socket: Bun.ServerWebSocket<SocketData>, message: string): void => {
  const command = Schema.decodeSync(Command)(message);
  if (command.id < 3) socket.send(JSON.stringify({ id: command.id }));
};

afterEach(() =>
  Promise.all(servers.splice(0).map((server) => server.stop(true))).then(() => undefined)
);

it.each(["heap", "profile"] as const)(
  "closes a silent %s inspector and bounded associated work without caller abort",
  (operation) =>
    Effect.runPromise(
      Effect.gen(function* () {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          const requested = Promise.withResolvers<void>();
          const disconnected = Promise.withResolvers<void>();
          const debuggerUrl = serveInspector(
            (socket, message) => {
              const command = Schema.decodeSync(Command)(message);
              if (operation === "profile" && command.id < 3) acknowledgeStart(socket, message);
              else requested.resolve();
            },
            () => disconnected.resolve()
          );
          let requestSignal = Option.none<AbortSignal>();
          let cancelled = false;
          const work =
            operation === "heap"
              ? heapUsage({ debuggerUrl, signal: Option.none() })
              : profileWorkerRequest({
                  debuggerUrl,
                  signal: Option.none(),
                  sendRequest: (signal) => {
                    requestSignal = Option.some(signal);
                    return Promise.resolve(
                      new Response(
                        new ReadableStream({
                          cancel(): Promise<void> {
                            cancelled = true;
                            return Promise.withResolvers<void>().promise;
                          },
                        })
                      )
                    );
                  },
                });
          const outcome = work.then(
            () => "unexpected success",
            (failure: unknown) => failure
          );
          yield* Effect.tryPromise(() => requested.promise);
          yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(30_001));
          expect(yield* Effect.tryPromise(() => outcome)).toMatchObject({
            _tag: "InspectorIoError",
            cause: { _tag: "TimeoutError" },
          });
          yield* Effect.tryPromise(() => disconnected.promise);
          if (operation === "profile") {
            expect(Option.isSome(requestSignal) && requestSignal.value.aborted).toBe(true);
            expect(cancelled).toBe(true);
          }
        } finally {
          vi.useRealTimers();
        }
      })
    )
);

describe("workerd inspector", () => {
  it.live(
    "closes the socket and aborts the in-flight request when profiling is interrupted",
    () => {
      const controller = new AbortController();
      return Effect.gen(function* () {
        let requestSignal = Option.none<AbortSignal>();
        const disconnected = Promise.withResolvers<void>();
        const debuggerUrl = serveInspector(acknowledgeStart, () => disconnected.resolve());
        const requested = Promise.withResolvers<void>();
        const pending = Promise.withResolvers<Response>();
        const profile = profileWorkerRequest({
          debuggerUrl,
          signal: Option.some(controller.signal),
          sendRequest: (signal) => {
            requestSignal = Option.some(signal);
            requested.resolve();
            return pending.promise;
          },
        });
        yield* Effect.tryPromise(() => requested.promise);
        controller.abort();
        const failure = yield* Effect.tryPromise({
          try: () => profile,
          catch: (cause) => new InspectorTestError({ cause }),
        }).pipe(Effect.flip);
        expect(failure.cause).toMatchObject({ _tag: "InspectorIoError" });
        expect(Option.isSome(requestSignal) && requestSignal.value.aborted).toBe(true);
        yield* Effect.tryPromise(() => disconnected.promise);
      });
    }
  );

  it.live("releases a late HTTP response after interruption", () => {
    const controller = new AbortController();
    return Effect.gen(function* () {
      const pending = Promise.withResolvers<Response>();
      const requested = Promise.withResolvers<void>();
      const debuggerUrl = serveInspector(acknowledgeStart);
      const profile = profileWorkerRequest({
        debuggerUrl,
        signal: Option.some(controller.signal),
        sendRequest: () => {
          requested.resolve();
          return pending.promise;
        },
      });
      yield* Effect.tryPromise(() => requested.promise);
      controller.abort();
      const failure = yield* Effect.tryPromise({
        try: () => profile,
        catch: (cause) => new InspectorTestError({ cause }),
      }).pipe(Effect.flip);
      expect(failure.cause).toMatchObject({ _tag: "InspectorIoError" });
      const cancelled = Promise.withResolvers<void>();
      const body = new ReadableStream({ cancel: (): void => cancelled.resolve() });
      pending.resolve(new Response(body));
      yield* Effect.tryPromise(() => cancelled.promise);
    });
  });

  it.live("keeps a successful HTTP response readable after closing the inspector", () =>
    Effect.gen(function* () {
      let requestSignal = Option.none<AbortSignal>();
      const debuggerUrl = serveInspector((socket, message) => {
        const command = Schema.decodeSync(Command)(message);
        socket.send(
          JSON.stringify(
            command.id === 3
              ? {
                  id: 3,
                  result: {
                    profile: {
                      nodes: [{ id: 1, callFrame: { functionName: "(idle)" } }],
                      samples: [1],
                      timeDeltas: [1000],
                    },
                  },
                }
              : { id: command.id }
          )
        );
      });
      const result = yield* Effect.tryPromise(() =>
        profileWorkerRequest({
          debuggerUrl,
          signal: Option.none(),
          sendRequest: (signal) => {
            requestSignal = Option.some(signal);
            return Promise.resolve(new Response("Profile content"));
          },
        })
      );
      expect(Option.isSome(requestSignal) && requestSignal.value.aborted).toBe(false);
      expect(yield* Effect.tryPromise(() => result.response.text())).toBe("Profile content");
    })
  );

  it.live("releases the HTTP body when the CPU profile is malformed", () =>
    Effect.gen(function* () {
      let cancelled = false;
      const debuggerUrl = serveInspector((socket, message) => {
        const command = Schema.decodeSync(Command)(message);
        socket.send(JSON.stringify({ id: command.id, result: {} }));
      });
      const failure = yield* Effect.tryPromise({
        try: () =>
          profileWorkerRequest({
            debuggerUrl,
            signal: Option.none(),
            sendRequest: () =>
              Promise.resolve(
                new Response(
                  new ReadableStream({
                    cancel: (): void => {
                      cancelled = true;
                    },
                  })
                )
              ),
          }),
        catch: (cause) => new InspectorTestError({ cause }),
      }).pipe(Effect.flip);
      expect(failure.cause).toMatchObject({ _tag: "InspectorIoError" });
      expect(cancelled).toBe(true);
    })
  );

  it.live("reports disconnects as typed I/O failures", () =>
    Effect.gen(function* () {
      const debuggerUrl = serveInspector((socket) => socket.close());
      const failure = yield* Effect.tryPromise({
        try: () => heapUsage({ debuggerUrl, signal: Option.none() }),
        catch: (cause) => new InspectorTestError({ cause }),
      }).pipe(Effect.flip);
      expect(failure.cause).toMatchObject({ _tag: "InspectorIoError" });
    })
  );
});
