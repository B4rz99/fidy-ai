import { Data, Schema } from "effect";
import { browserSessionBindingPath } from "@fidy/server/browser-transport";

type ResponseOutcome = Promise<PromiseSettledResult<Response>>;

type ResponseClaim = Data.TaggedEnum<{
  Prepared: { readonly result: ResponseOutcome };
  Network: {};
}>;

const ResponseClaim = Data.taggedEnum<ResponseClaim>();

const isRequest = Schema.is(Schema.instanceOf(Request));

const successfulResponseStatus = 200;

const initialRequestDeadlineMilliseconds = 10000;

export type InitialBrowserRequest = Readonly<{
  apiOrigin: string;
  context: boolean;
  transactions: boolean;
  url: string;
  result: ResponseOutcome;
  cancel: () => void;
  release: () => void;
  isCurrent: () => boolean;
  signal: AbortSignal;
  takeResponse: (url: string) => ResponseClaim;
}>;

const requestLifetime = (): Pick<
  InitialBrowserRequest,
  "cancel" | "release" | "isCurrent" | "signal"
> => {
  const controller = new AbortController();
  let current = true;

  return {
    cancel: () => {
      current = false;
      controller.abort();
    },
    release: () => undefined,
    isCurrent: () => current,
    signal: controller.signal,
  };
};

const settleResponse = (
  nativeFetch: typeof globalThis.fetch,
  ...args: Parameters<typeof globalThis.fetch>
): ResponseOutcome =>
  nativeFetch(...args).then<PromiseSettledResult<Response>, PromiseSettledResult<Response>>(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ status: "rejected", reason })
  );

const send = (
  url: string,
  signal: AbortSignal,
  nativeFetch: typeof globalThis.fetch
): ResponseOutcome =>
  settleResponse(nativeFetch, url, {
    credentials: "include",
    priority: "high",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(initialRequestDeadlineMilliseconds)]),
  });

export const beginInitialBrowserRequest = ({
  apiOrigin,
  context,
  transactions,
}: Readonly<{
  apiOrigin: string;
  context: boolean;
  transactions: boolean;
}>): InitialBrowserRequest => {
  const lifetime = requestLifetime();
  const nativeFetch = globalThis.fetch;
  const identity = new URL(browserSessionBindingPath, apiOrigin).href;
  const url = new URL(identity);

  if (context) url.searchParams.set("context", transactions ? "transactions" : "application");
  const result = send(url.href, lifetime.signal, nativeFetch);

  const recheck = context
    ? result.then((outcome): ResponseOutcome =>
        outcome.status === "fulfilled" &&
        outcome.value.status === successfulResponseStatus &&
        lifetime.isCurrent()
          ? send(identity, lifetime.signal, nativeFetch)
          : Promise.resolve({
              status: "rejected",
              reason: new DOMException("No prepared recheck", "AbortError"),
            })
      )
    : undefined;

  const claimed = new Set<string>();
  let recheckUsable = true;

  const takeResponse = (requested: string): ResponseClaim => {
    if (claimed.has(requested)) {
      if (requested === url.href) recheckUsable = false;

      return ResponseClaim.Network();
    }

    if (requested === url.href) {
      claimed.add(requested);

      return ResponseClaim.Prepared({ result });
    }

    if (requested === identity && recheck !== undefined && recheckUsable) {
      claimed.add(requested);

      return ResponseClaim.Prepared({ result: recheck });
    }

    return ResponseClaim.Network();
  };

  return { apiOrigin, context, transactions, url: url.href, result, ...lifetime, takeResponse };
};

const requestMethod = (...args: Parameters<typeof globalThis.fetch>): string =>
  args[1]?.method ?? (isRequest(args[0]) ? args[0].method : "GET");

export const initialRequestFetch = (initial: InitialBrowserRequest): typeof globalThis.fetch => {
  const nativeFetch = globalThis.fetch;

  const preparedFetch = (...args: Parameters<typeof globalThis.fetch>): Promise<Response> =>
    Promise.resolve().then(() => {
      const [input, init] = args;

      if (!initial.isCurrent()) {
        throw new DOMException("Authentication lifetime ended", "AbortError");
      }

      const url = isRequest(input) ? input.url : String(input);
      const method = requestMethod(...args);
      const prepared = method === "GET" ? initial.takeResponse(url) : ResponseClaim.Network();

      return ResponseClaim.$match(prepared, {
        Network: () => settleResponse(nativeFetch, input, init),
        Prepared: ({ result }) => result,
      }).then((result) => {
        if (result.status === "rejected") throw result.reason;

        return result.value;
      });
    });

  return Object.assign(preparedFetch, nativeFetch);
};
