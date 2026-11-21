import { Brand, DateTime } from "effect";
import { IanaTimeZone } from "~/core/_shared/context";
import {
  HostedActiveRequest,
  HostedContextSection,
  type HostedInitialTextContext,
} from "~/shell/hosted-inference/contract";

const makeHostedInitialTextContext = Brand.nominal<HostedInitialTextContext>();

export const hostedInitialTextContext = (text: string): HostedInitialTextContext =>
  makeHostedInitialTextContext({
    sections: [
      HostedContextSection.AssistantPolicy({
        channel: "web",
        user: {
          serviceMarket: "CO",
          locale: "es-CO",
          timeZone: IanaTimeZone.make("America/Bogota"),
        },
      }),
      HostedContextSection.TurnStarted({
        timeZone: "America/Bogota",
        startedAt: DateTime.makeUnsafe("2026-09-22T12:00:00Z"),
      }),
    ],
    activeRequest: HostedActiveRequest.Present({ text }),
  });
