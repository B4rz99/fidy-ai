import { browserCrypto } from "@/browser/crypto";
import { Effect, Option, Schema } from "effect";

const channelName = "fidy:authentication-lifetime";
const tabId = Effect.runSync(browserCrypto.randomUUIDv4().pipe(Effect.orDie));
const Transition = Schema.Struct({ event: Schema.Literal("changed"), sender: Schema.String });
export const authenticationEndedEvent = "fidy:authentication-ended";

/** Retire this tab synchronously and notify other mounted tabs without transmitting any identity. */
export const announceAuthenticationTransition = (): void => {
  window.dispatchEvent(new Event(authenticationEndedEvent));
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(channelName);
  channel.postMessage({ event: "changed", sender: tabId });
  channel.close();
};

/** Observe other tabs only; visibility validation independently covers missed/suspended messages. */
export const observeAuthenticationTransitions = (changed: () => void): (() => void) => {
  if (typeof BroadcastChannel === "undefined") return () => undefined;
  const channel = new BroadcastChannel(channelName);
  channel.onmessage = (event): void => {
    const transition = Schema.decodeUnknownOption(Transition)(event.data);
    if (Option.isSome(transition) && transition.value.sender !== tabId) changed();
  };
  return () => channel.close();
};
