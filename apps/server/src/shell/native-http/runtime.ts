import { Option } from "effect";

const noContentStatus = 204;
const resetContentStatus = 205;
const notModifiedStatus = 304;
const noBodyStatuses = new Set([noContentStatus, resetContentStatus, notModifiedStatus]);

const disposeReader = (
  reader: ReadableStreamDefaultReader<unknown>,
  cancelSource: boolean
): void => {
  try {
    if (cancelSource) reader.cancel().catch(() => undefined);
  } catch {
    // Native cleanup must never replace the primary outcome.
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A broken native adapter cannot reopen terminal ownership.
    }
  }
};

const ownBody = (
  reader: ReadableStreamDefaultReader<unknown>,
  signal: Option.Option<AbortSignal>
): ReadableStream<Uint8Array> => {
  let phase: "Open" | "Reading" | "Closed" | "Cancelled" | "Errored" = "Open";
  const active = (): boolean => phase === "Open" || phase === "Reading";
  const release = (cancelSource: boolean): void => {
    Option.getOrUndefined(signal)?.removeEventListener("abort", abort);
    disposeReader(reader, cancelSource);
  };
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const abort = (): void => {
    if (!active()) return;
    phase = "Cancelled";
    controller.error(new TypeError("Response body aborted"));
    release(true);
  };
  const cancel = (): void => {
    if (!active()) return;
    phase = "Cancelled";
    release(true);
  };
  const body = new ReadableStream<Uint8Array>(
    {
      start(value): void {
        controller = value;
      },
      pull(value): Promise<void> {
        if (phase !== "Open") return Promise.resolve();
        phase = "Reading";
        return Promise.try(() => reader.read())
          .then((next) => {
            if (!active()) return;
            if (next.done) {
              phase = "Closed";
              release(false);
              value.close();
            } else {
              if (!(next.value instanceof Uint8Array)) {
                throw new TypeError("Response chunk must be Uint8Array");
              }
              phase = "Open";
              value.enqueue(next.value);
            }
          })
          .catch((error: unknown) => {
            if (!active()) return;
            phase = "Errored";
            release(true);
            value.error(error);
          });
      },
      cancel,
    },
    { highWaterMark: 0 }
  );
  Option.getOrUndefined(signal)?.addEventListener("abort", abort, { once: true });
  if (Option.getOrUndefined(signal)?.aborted === true) abort();
  return body;
};

/**
 * Transfers one unlocked, unconsumed native Response and its exact resolved request signal.
 * Use only the returned Response, and consume, cancel or abort its scope instead of abandoning it.
 * Cleanup failures stay private and never delay disposal or replace the primary outcome.
 */
export const ownNativeResponse = ({
  response,
  signal,
}: Readonly<{ response: Response; signal: Option.Option<AbortSignal> }>): Response => {
  if (response.body === null) return response;
  const reader: ReadableStreamDefaultReader<unknown> = response.body.getReader();
  const init = {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  };
  if (noBodyStatuses.has(response.status)) {
    disposeReader(reader, true);
    return new Response(null, init);
  }
  return new Response(ownBody(reader, signal), init);
};

/** Fetch signal inheritance treats explicit null as detachment and undefined as inheritance. */
export const ownNativeFetch = (native: typeof globalThis.fetch): typeof globalThis.fetch =>
  Object.assign(
    (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      let signal = Option.fromNullishOr(init?.signal);
      if (init?.signal === undefined && input instanceof Request) {
        signal = Option.some(input.signal);
      }
      return native(input, init).then((response) => ownNativeResponse({ response, signal }));
    },
    { preconnect: native.preconnect }
  );
