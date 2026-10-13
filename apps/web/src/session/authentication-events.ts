const channelName = "fidy:authentication-lifetime";
export const authenticationEndedEvent = "fidy:authentication-ended";

/** Retire this tab synchronously and notify other mounted tabs without transmitting any identity. */
export const announceAuthenticationTransition = (): void => {
  window.dispatchEvent(new Event(authenticationEndedEvent));
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(channelName);
  channel.postMessage("changed");
  channel.close();
};

/** Observe other tabs only; visibility validation independently covers missed/suspended messages. */
export const observeAuthenticationTransitions = (changed: () => void): (() => void) => {
  if (typeof BroadcastChannel === "undefined") return () => undefined;
  const channel = new BroadcastChannel(channelName);
  channel.onmessage = (event): void => {
    if (event.data === "changed") changed();
  };
  return () => channel.close();
};
