import { Brand, DateTime } from "effect";
import { IanaTimeZone } from "~/core/_shared/context";
import type { HostedInitialTextContext } from "./contract";

const makeHostedInitialTextContext = Brand.nominal<HostedInitialTextContext>();

export const hostedInitialTextContext = (text: string): HostedInitialTextContext =>
  makeHostedInitialTextContext({
    sections: [
      {
        _tag: "AssistantPolicy",
        user: {
          serviceMarket: "CO",
          locale: "es-CO",
          timeZone: IanaTimeZone.make("America/Bogota"),
        },
      },
      { _tag: "TurnStarted", startedAt: DateTime.makeUnsafe("2026-09-22T12:00:00Z") },
    ],
    activeRequest: { _tag: "Present", text },
  });
