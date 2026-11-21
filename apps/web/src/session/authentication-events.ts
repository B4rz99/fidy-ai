import { browserSecureRandom } from "@/browser/crypto";
import { browserRuntime } from "@/transport/browser-runtime";
import { Effect, Option, Schema } from "effect";

import {
  authenticationEndedEvent,
  authenticationChannelName as channelName,
} from "./authentication-channel";

export { authenticationEndedEvent } from "./authentication-channel";

const tabId = browserRuntime.runSync(browserSecureRandom.uuidV4().pipe(Effect.orDie));

const Transition = Schema.Struct({ event: Schema.Literal("changed"), sender: Schema.String });

export const announceAuthenticationTransition = (): void => {
  window.dispatchEvent(new Event(authenticationEndedEvent));

  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(channelName);
  channel.postMessage({ event: "changed", sender: tabId });
  channel.close();
};

export const observeAuthenticationTransitions = (changed: () => void): (() => void) => {
  if (typeof BroadcastChannel === "undefined") return () => undefined;
  const channel = new BroadcastChannel(channelName);
  channel.onmessage = (event): void => {
    const transition = Schema.decodeUnknownOption(Transition)(event.data);

    if (Option.isSome(transition) && transition.value.sender !== tabId) changed();
  };

  return () => channel.close();
};
