import type { InitialBrowserRequest } from "@/transport/initial-request";
import { authenticationChannelName, authenticationEndedEvent } from "./authentication-channel";

export const observeInitialBrowserRequest = (
  request: InitialBrowserRequest
): InitialBrowserRequest => {
  const channel =
    typeof BroadcastChannel === "undefined"
      ? undefined
      : new BroadcastChannel(authenticationChannelName);

  const release = (): void => {
    channel?.close();

    if (typeof window !== "undefined") window.removeEventListener(authenticationEndedEvent, cancel);
    request.release();
  };

  const cancel = (): void => {
    request.cancel();
    release();
  };

  if (channel !== undefined) channel.onmessage = cancel;

  if (typeof window !== "undefined") window.addEventListener(authenticationEndedEvent, cancel);

  return { ...request, cancel, release };
};
