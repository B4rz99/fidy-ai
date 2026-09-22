import { Option, Schema } from "effect";

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

/** Discovers the first workerd DevTools target or fails when no inspectable isolate exists. */
// @effect-diagnostics-next-line asyncFunction:off -- DevTools HTTP discovery seam.
export const inspectorTarget = async (port: number): Promise<string> => {
  const response = await fetch(`http://127.0.0.1:${port}/json`);
  const targets = Schema.decodeUnknownSync(InspectorTargets)(await response.json());
  const target = targets[0];
  if (target === undefined) throw new Error("Workerd inspector target is unavailable");
  return target.webSocketDebuggerUrl;
};

/** Profiles one supplied HTTP request and returns its response plus sampled non-idle V8 time. */
// @effect-diagnostics-next-line missingPipeableSignature:off -- callback-oriented DevTools protocol adapter.
export const profileWorkerRequest = (
  debuggerUrl: string,
  sendRequest: () => Promise<Response>
): Promise<{ readonly cpuMilliseconds: number; readonly response: Response }> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(debuggerUrl);
    let response = Option.none<Response>();
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: 1, method: "Profiler.enable" }));
    });
    socket.addEventListener("message", (event) => {
      const message = String(event.data);
      const envelope = Schema.decodeOption(Schema.fromJsonString(InspectorMessage))(message);
      if (Option.isNone(envelope)) return;
      if (envelope.value.id === 1) {
        socket.send(JSON.stringify({ id: 2, method: "Profiler.start" }));
      } else if (envelope.value.id === 2) {
        sendRequest().then((requestResponse) => {
          response = Option.some(requestResponse);
          socket.send(JSON.stringify({ id: 3, method: "Profiler.stop" }));
        }, reject);
      } else if (envelope.value.id === 3) {
        try {
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
          if (Option.isNone(response)) {
            reject(new Error("Worker CPU profile completed without an HTTP response"));
          } else {
            socket.close();
            resolve({
              cpuMilliseconds: activeMicroseconds / microsecondsPerMillisecond,
              response: response.value,
            });
          }
        } catch (failure) {
          reject(failure);
        }
      }
    });
    socket.addEventListener("error", () => reject(new Error("Worker CPU profiler failed")));
  });

/** Reads current retained V8 heap bytes from a workerd DevTools target. */
export const heapUsage = (debuggerUrl: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(debuggerUrl);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: 1, method: "Runtime.getHeapUsage" }));
    });
    socket.addEventListener("message", (event) => {
      try {
        const usage = Schema.decodeSync(Schema.fromJsonString(HeapUsage))(String(event.data));
        socket.close();
        resolve(usage.result.usedSize);
      } catch {
        // Inspector notifications may arrive before the response carrying this request id.
      }
    });
    socket.addEventListener("error", () => reject(new Error("Worker inspector failed")));
  });
