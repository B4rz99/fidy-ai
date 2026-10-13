import { Option } from "effect";

/** Owns native response readers without awaiting an untrusted source's cancellation promise. */
export const ownBrowserResponse = ({
  response,
  signal: signalOption,
}: Readonly<{ response: Response; signal: Option.Option<AbortSignal> }>): Response => {
  if (response.body === null) return response;
  const signal = Option.getOrUndefined(signalOption);
  const reader = response.body.getReader();
  let finished = false;
  const release = (): void => {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  };
  const cancel = (): void => {
    if (finished) return;
    finished = true;
    try {
      reader.cancel().catch(() => undefined);
    } catch {
      // Cleanup failure from the native source cannot retain the reader or delay refusal.
    } finally {
      release();
    }
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const body = new ReadableStream<Uint8Array>({
    pull(controller): Promise<void> {
      return reader.read().then(
        (next) => {
          if (finished) return;
          if (next.done) {
            finished = true;
            release();
            controller.close();
          } else {
            controller.enqueue(next.value);
          }
        },
        (error: unknown) => {
          if (finished) return;
          finished = true;
          release();
          controller.error(error);
        }
      );
    },
    cancel,
  });
  if (signal?.aborted === true) cancel();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};
