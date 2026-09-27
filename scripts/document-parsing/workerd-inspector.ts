import { Data, Effect, Option, Schema } from "effect";

const microsecondsPerMillisecond = Number("1000");

const InspectorMessage = Schema.Struct({ id: Schema.Finite });
const InspectorTargets = Schema.Array(Schema.Struct({ webSocketDebuggerUrl: Schema.String }));
const HeapUsage = Schema.Struct({
  id: Schema.Finite,
  result: Schema.Struct({ usedSize: Schema.Finite }),
});
const CpuProfileResponse = Schema.Struct({
  id: Schema.Literal(3),
  result: Schema.Struct({
    profile: Schema.Struct({
      nodes: Schema.Array(
        Schema.Struct({
          callFrame: Schema.Struct({ functionName: Schema.String }),
          id: Schema.Int,
        })
      ),
      samples: Schema.Array(Schema.Int),
      timeDeltas: Schema.Array(Schema.Finite),
    }),
  }),
});

class InspectorIoError extends Data.TaggedError("InspectorIoError")<{
  readonly cause: unknown;
}> {}

const requestTargets = (port: number, signal: AbortSignal): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}/json`, { signal });

const fetchTargets = (
  port: number,
  signal?: AbortSignal
): Effect.Effect<unknown, InspectorIoError> =>
  Effect.tryPromise({
    try: (requestSignal) => requestTargets(port, signal ?? requestSignal),
    catch: (cause) => new InspectorIoError({ cause }),
  }).pipe(
    Effect.flatMap((response) =>
      Effect.tryPromise({
        try: () => response.json(),
        catch: (cause) => new InspectorIoError({ cause }),
      })
    )
  );

/** Discovers the first workerd DevTools target or fails when no inspectable isolate exists. */
export const inspectorTarget = ({
  port,
  signal,
}: Readonly<{ port: number; signal: Option.Option<AbortSignal> }>): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const targets = yield* Schema.decodeUnknownEffect(InspectorTargets)(
        yield* fetchTargets(port, Option.getOrUndefined(signal))
      );
      const target = targets[0];
      if (target === undefined) throw new Error("Workerd inspector target is unavailable");
      return target.webSocketDebuggerUrl;
    })
  );

type InspectorContext<A> = {
  readonly socket: WebSocket;
  readonly signal: AbortSignal;
  readonly succeed: (value: A) => void;
  readonly fail: (failure: unknown) => void;
};

type SocketOptions<A> = {
  readonly debuggerUrl: string;
  readonly command: string;
  readonly handler: (message: string, context: InspectorContext<A>) => void;
  readonly onFailure: Option.Option<() => void>;
};

const attachSocket = <A>({
  socket,
  options,
  context,
}: Readonly<{
  socket: WebSocket;
  options: SocketOptions<A>;
  context: InspectorContext<A>;
}>): void => {
  socket.addEventListener("open", () => {
    if (context.signal.aborted) return;
    try {
      socket.send(options.command);
    } catch (failure) {
      context.fail(failure);
    }
  });
  socket.addEventListener("message", (event) => {
    if (context.signal.aborted) return;
    try {
      options.handler(String(event.data), context);
    } catch (failure) {
      context.fail(failure);
    }
  });
  socket.addEventListener("error", () => context.fail(new Error("Worker inspector failed")));
  socket.addEventListener("close", () => context.fail(new Error("Worker inspector disconnected")));
};

const inspectSocket = <A>(
  options: SocketOptions<A>,
  signal?: AbortSignal
): Effect.Effect<A, InspectorIoError> =>
  Effect.callback<A, InspectorIoError>((resume, interrupted) => {
    const controller = new AbortController();
    let socket = Option.none<WebSocket>();
    let settled = false;
    const cleanup = (): void => {
      signal?.removeEventListener("abort", abort);
      interrupted.removeEventListener("abort", abort);
      controller.abort();
      if (Option.isSome(socket)) socket.value.close();
    };
    const finish = (result: { readonly value: A } | { readonly failure: unknown }): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if ("failure" in result) {
        if (Option.isSome(options.onFailure)) options.onFailure.value();
        resume(Effect.fail(new InspectorIoError({ cause: result.failure })));
      } else resume(Effect.succeed(result.value));
    };
    const fail = (failure: unknown): void => finish({ failure });
    const abort = (): void => fail(new Error("Worker inspector interrupted"));
    signal?.addEventListener("abort", abort, { once: true });
    interrupted.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true || interrupted.aborted) {
      abort();
    } else {
      try {
        const connectedSocket = new WebSocket(options.debuggerUrl);
        socket = Option.some(connectedSocket);
        attachSocket({
          socket: connectedSocket,
          options,
          context: {
            socket: connectedSocket,
            signal: controller.signal,
            succeed: (value) => finish({ value }),
            fail,
          },
        });
      } catch (failure) {
        fail(failure);
      }
    }
    return Effect.sync(() => {
      if (!settled) {
        settled = true;
        cleanup();
        if (Option.isSome(options.onFailure)) options.onFailure.value();
      }
    });
  });

const activeCpuMilliseconds = (message: string): number => {
  const result = Schema.decodeSync(Schema.fromJsonString(CpuProfileResponse))(message);
  const namesById = new Map(
    result.result.profile.nodes.map((node) => [node.id, node.callFrame.functionName])
  );
  const activeMicroseconds = result.result.profile.samples.reduce(
    (total, sample, index) =>
      namesById.get(sample) === "(idle)"
        ? total
        : total + (result.result.profile.timeDeltas[index] ?? 0),
    0
  );
  return activeMicroseconds / microsecondsPerMillisecond;
};

type ProfileResult = { readonly cpuMilliseconds: number; readonly response: Response };

const cancelResponse = (response: Response): void => {
  if (response.body !== null) {
    response.body.cancel().catch(() => undefined);
  }
};

const handleProfileMessage = (
  message: string,
  context: InspectorContext<ProfileResult> & {
    readonly sendRequest: (signal: AbortSignal) => Promise<Response>;
    readonly response: Option.Option<Response>;
    readonly setResponse: (value: Response) => void;
  }
): void => {
  const { socket, signal, sendRequest, response, setResponse, succeed, fail } = context;
  const envelope = Schema.decodeOption(Schema.fromJsonString(InspectorMessage))(message);
  if (Option.isNone(envelope)) return;
  if (envelope.value.id === 1) {
    socket.send(JSON.stringify({ id: 2, method: "Profiler.start" }));
  } else if (envelope.value.id === 2) {
    sendRequest(signal).then((requestResponse) => {
      if (signal.aborted) {
        cancelResponse(requestResponse);
        return;
      }
      setResponse(requestResponse);
      try {
        socket.send(JSON.stringify({ id: 3, method: "Profiler.stop" }));
      } catch (failure) {
        fail(failure);
      }
    }, fail);
  } else if (envelope.value.id === 3) {
    const cpuMilliseconds = activeCpuMilliseconds(message);
    if (Option.isNone(response)) {
      fail(new Error("Worker CPU profile completed without an HTTP response"));
    } else succeed({ cpuMilliseconds, response: response.value });
  }
};

/** Profiles one supplied HTTP request and returns its response plus sampled non-idle V8 time. */
export const profileWorkerRequest = ({
  debuggerUrl,
  sendRequest,
  signal,
}: Readonly<{
  debuggerUrl: string;
  sendRequest: (signal: AbortSignal) => Promise<Response>;
  signal: Option.Option<AbortSignal>;
}>): Promise<ProfileResult> => {
  let response = Option.none<Response>();
  const releaseResponse = (): void => {
    if (Option.isSome(response)) cancelResponse(response.value);
  };
  return Effect.runPromise(
    inspectSocket(
      {
        debuggerUrl,
        command: JSON.stringify({ id: 1, method: "Profiler.enable" }),
        handler: (message, context) =>
          handleProfileMessage(message, {
            ...context,
            sendRequest,
            response,
            setResponse: (value) => {
              response = Option.some(value);
            },
          }),
        onFailure: Option.some(releaseResponse),
      },
      Option.getOrUndefined(signal)
    )
  );
};

/** Reads current retained V8 heap bytes from a workerd DevTools target. */
export const heapUsage = ({
  debuggerUrl,
  signal,
}: Readonly<{ debuggerUrl: string; signal: Option.Option<AbortSignal> }>): Promise<number> =>
  Effect.runPromise(
    inspectSocket(
      {
        debuggerUrl,
        command: JSON.stringify({ id: 1, method: "Runtime.getHeapUsage" }),
        onFailure: Option.none(),
        handler: (message, { succeed }) => {
          const usage = Schema.decodeOption(Schema.fromJsonString(HeapUsage))(message);
          if (Option.isSome(usage) && usage.value.id === 1) succeed(usage.value.result.usedSize);
        },
      },
      Option.getOrUndefined(signal)
    )
  );
