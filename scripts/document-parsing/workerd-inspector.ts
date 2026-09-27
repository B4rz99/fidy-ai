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

const inspectSocket = <A>(
  options: {
    readonly debuggerUrl: string;
    readonly command: string;
    readonly handler: (message: string, context: InspectorContext<A>) => void;
  },
  signal?: AbortSignal
): Promise<A> =>
  new Promise((resolve, reject) => {
    const { command, debuggerUrl, handler } = options;
    const socket = new WebSocket(debuggerUrl);
    const controller = new AbortController();
    let settled = false;
    const finish = (result: { readonly value: A } | { readonly failure: unknown }): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      socket.close();
      if ("failure" in result) {
        controller.abort();
        reject(result.failure);
      } else resolve(result.value);
    };
    const fail = (failure: unknown): void => finish({ failure });
    const abort = (): void => fail(new Error("Worker inspector interrupted"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) abort();
    socket.addEventListener("open", () => {
      if (settled) return;
      try {
        socket.send(command);
      } catch (failure) {
        fail(failure);
      }
    });
    socket.addEventListener("message", (event) => {
      if (settled) return;
      try {
        handler(String(event.data), {
          socket,
          signal: controller.signal,
          succeed: (value) => finish({ value }),
          fail,
        });
      } catch (failure) {
        fail(failure);
      }
    });
    socket.addEventListener("error", () => fail(new Error("Worker inspector failed")));
    socket.addEventListener("close", () => fail(new Error("Worker inspector disconnected")));
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
        requestResponse.body?.cancel().catch(fail);
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
  return inspectSocket(
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
    },
    Option.getOrUndefined(signal)
  );
};

/** Reads current retained V8 heap bytes from a workerd DevTools target. */
export const heapUsage = ({
  debuggerUrl,
  signal,
}: Readonly<{ debuggerUrl: string; signal: Option.Option<AbortSignal> }>): Promise<number> =>
  inspectSocket(
    {
      debuggerUrl,
      command: JSON.stringify({ id: 1, method: "Runtime.getHeapUsage" }),
      handler: (message, { succeed }) => {
        const usage = Schema.decodeOption(Schema.fromJsonString(HeapUsage))(message);
        if (Option.isSome(usage) && usage.value.id === 1) succeed(usage.value.result.usedSize);
      },
    },
    Option.getOrUndefined(signal)
  );
