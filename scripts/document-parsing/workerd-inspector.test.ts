import { it } from "@effect/vitest";
import { Data, Effect, Option, Schema } from "effect";
import { afterEach, describe, expect } from "vitest";
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

describe("workerd inspector", () => {
  it.live(
    "closes the socket and aborts the in-flight request when profiling is interrupted",
    () => {
      const controller = new AbortController();
      return Effect.gen(function* () {
        let requestSignal = Option.none<AbortSignal>();
        let closed = false;
        const debuggerUrl = serveInspector(acknowledgeStart, () => {
          closed = true;
        });
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
        yield* Effect.sleep(10);
        expect(closed).toBe(true);
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
      let cancelled = false;
      const body = new ReadableStream({
        cancel: (): void => {
          cancelled = true;
        },
      });
      pending.resolve(new Response(body));
      yield* Effect.sleep(10);
      expect(cancelled).toBe(true);
    });
  });

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
