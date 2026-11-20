import { Option } from "effect";
import core, { UserStore as NativeUserStore } from "./core-worker";
import { workerInternalTraceHeader } from "./runtime/telemetry/contract";

export * from "./core-worker";

type Owner = "directoryMs" | "userStoreMs";
type Window = Partial<Record<Owner, number | "duplicate">> & {
  userStoreClock: Option.Option<readonly [started: number, returned: number]>;
};
const windows = new Map<string, Window>();
const maximumWindows = 64;
const readWindowsUrl = "https://route-clock.invalid/windows";
const readUserStoreWindowsUrl = "https://route-clock.invalid/user-store";
const fixtureTraceHeader = "x-fidy-workerd-owner-clock";
const traceParent = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/u;

type BindingClock = Readonly<{ window: Window; owner: Owner; trace: string }>;
const taggedUserStoreRequest = (request: Request, trace: string): Request => {
  const headers = new Headers(request.headers);
  headers.set(fixtureTraceHeader, trace);
  return new Request(request, { headers });
};

const timedStub = (stub: DurableObjectStub, clock: BindingClock): DurableObjectStub =>
  new Proxy(stub, {
    get(target, property) {
      if (property !== "fetch") return Reflect.get(target, property, target);
      return async (...args: Parameters<DurableObjectStub["fetch"]>) => {
        const { owner, trace, window } = clock;
        const [request, init] = args;
        const isUserStore = owner === "userStoreMs";
        const forwarded =
          isUserStore && request instanceof Request
            ? taggedUserStoreRequest(request, trace)
            : request;
        const start = performance.now();
        const started = isUserStore ? Date.now() : 0;
        try {
          return await target.fetch(forwarded, init);
        } finally {
          window[owner] = window[owner] === undefined ? performance.now() - start : "duplicate";
          if (isUserStore) window.userStoreClock = Option.some([started, Date.now()]);
        }
      };
    },
  });

const timedNamespace = (
  namespace: DurableObjectNamespace,
  clock: BindingClock
): DurableObjectNamespace =>
  new Proxy(namespace, {
    get(target, property) {
      if (property !== "getByName") return Reflect.get(target, property, target);
      return (...args: Parameters<DurableObjectNamespace["getByName"]>) =>
        timedStub(target.getByName(...args), clock);
    },
  });

const historyTrace = (request: Request): Option.Option<string> => {
  if (request.method !== "GET") return Option.none();
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
      return Response.json(
        [...windows].map(([trace, { userStoreClock, ...window }]) => [
          trace,
          {
            ...window,
            ...Option.match(userStoreClock, {
              onNone: () => ({}),
              onSome: ([userStoreStartedAt, userStoreReturnedAt]) => ({
                userStoreStartedAt,
                userStoreReturnedAt,
              }),
            }),
          },
        ])
      );
    }
    const trace = historyTrace(request);
    const { DIRECTORY, USER_STORE } = environment;
    if (Option.isNone(trace) || !DIRECTORY || !USER_STORE || windows.size >= maximumWindows) {
      return core.fetch(...args);
    }
    const window: Window = { userStoreClock: Option.none() };
    windows.set(trace.value, window);
    return core.fetch(
      request,
      {
        ...environment,
        DIRECTORY: timedNamespace(DIRECTORY, { window, owner: "directoryMs", trace: trace.value }),
        USER_STORE: timedNamespace(USER_STORE, {
          window,
          owner: "userStoreMs",
          trace: trace.value,
        }),
      },
      context
    );
  },
};

export { observedCore as default };

export class UserStore extends NativeUserStore {
  private readonly requests = new Map<string, readonly [entered: number, ready: number]>();

  override async fetch(request: Request): Promise<Response> {
    if (request.method === "GET" && request.url === readUserStoreWindowsUrl) {
      return Response.json([...this.requests]);
    }
    const trace = request.headers.get(fixtureTraceHeader);
    if (trace === null) return super.fetch(request);
    const entered = Date.now();
    const headers = new Headers(request.headers);
    headers.delete(fixtureTraceHeader);
    const response = await super.fetch(new Request(request, { headers }));
    if (/^[0-9a-f]{32}$/u.test(trace) && this.requests.size < maximumWindows) {
      this.requests.set(trace, [entered, Date.now()]);
    }
    return response;
  }
}
