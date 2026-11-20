import { Option } from "effect";
import core from "./core-worker";
import { workerInternalTraceHeader } from "./runtime/telemetry/contract";

export * from "./core-worker";

type Owner = "directoryMs" | "userStoreMs";
type Window = Partial<Record<Owner, number | "duplicate">>;
const windows = new Map<string, Window>();
const maximumWindows = 64;
const readWindowsUrl = "https://route-clock.invalid/windows";
const traceParent = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/u;

const timedStub = (stub: DurableObjectStub, window: Window, owner: Owner): DurableObjectStub =>
  new Proxy(stub, {
    get(target, property) {
      if (property !== "fetch") return Reflect.get(target, property, target);
      return async (...args: Parameters<DurableObjectStub["fetch"]>) => {
        const start = performance.now();
        try {
          return await target.fetch(...args);
        } finally {
          window[owner] = window[owner] === undefined ? performance.now() - start : "duplicate";
        }
      };
    },
  });

const timedNamespace = (
  namespace: DurableObjectNamespace,
  window: Window,
  owner: Owner
): DurableObjectNamespace =>
  new Proxy(namespace, {
    get(target, property) {
      if (property !== "getByName") return Reflect.get(target, property, target);
      return (...args: Parameters<DurableObjectNamespace["getByName"]>) =>
        timedStub(target.getByName(...args), window, owner);
    },
  });

const historyTrace = (request: Request): Option.Option<string> => {
  if (request.method !== "GET" || windows.size >= maximumWindows) return Option.none();
  const url = new URL(request.url);
  if (url.pathname !== "/transactions" || url.search !== "?limit=25") return Option.none();
  return Option.fromUndefinedOr(
    traceParent.exec(request.headers.get(workerInternalTraceHeader) ?? "")?.[1]
  );
};

const observedCore = {
  ...core,
  async fetch(...args: Parameters<typeof core.fetch>): Promise<Response> {
    const [request, environment, context] = args;
    if (request.method === "GET" && request.url === readWindowsUrl) {
      return Response.json([...windows]);
    }
    const trace = historyTrace(request);
    const { DIRECTORY, USER_STORE } = environment;
    if (Option.isNone(trace) || !DIRECTORY || !USER_STORE) return core.fetch(...args);
    const window: Window = {};
    windows.set(trace.value, window);
    return core.fetch(
      request,
      {
        ...environment,
        DIRECTORY: timedNamespace(DIRECTORY, window, "directoryMs"),
        USER_STORE: timedNamespace(USER_STORE, window, "userStoreMs"),
      },
      context
    );
  },
};

export { observedCore as default };
