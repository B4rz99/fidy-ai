import { Option, Schema } from "effect";

const noContentStatus = 204;
const resetContentStatus = 205;
const notModifiedStatus = 304;
const responseStatusForbidsBody = (status: number): boolean =>
  status === noContentStatus || status === resetContentStatus || status === notModifiedStatus;

/** Owns native response readers without awaiting an untrusted source's cancellation promise. */
export const ownBrowserResponse = ({
  response,
  signal: signalOption,
}: Readonly<{ response: Response; signal: Option.Option<AbortSignal> }>): Response => {
  if (response.body === null) return response;
  const signal = Option.getOrUndefined(signalOption);
  const reader = response.body.getReader();
  const responseInit = {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  };
  let finished = false;
  const release = (): void => {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  };
  const cancel = (): void => {
    if (finished) return;
    finished = true;
    reader.cancel().catch(() => undefined);
    release();
  };
  // A browser can expose an empty native stream even when this status forbids a Response body.
  if (responseStatusForbidsBody(response.status)) {
    cancel();
    return new Response(null, responseInit);
  }
  signal?.addEventListener("abort", cancel, { once: true });
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller): Promise<void> {
        return reader
          .read()
          .then((next) => {
            if (finished) return;
            if (next.done) {
              finished = true;
              release();
              controller.close();
            } else {
              controller.enqueue(Schema.decodeSync(Schema.Uint8Array)(next.value));
            }
          })
          .catch((error: unknown) => {
            if (finished) return;
            cancel();
            controller.error(error);
          });
      },
      cancel,
    },
    { highWaterMark: 0 }
  );
  if (signal?.aborted === true) cancel();
  return new Response(body, responseInit);
};
