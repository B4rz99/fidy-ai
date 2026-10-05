import { expect, it } from "@effect/vitest";
import { Context, Effect, Option, Redacted } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { WhatsAppBusinessPhoneNumberId, WhatsAppMediaId } from "~/shell/channels/whatsapp/contract";
import { makeKapsoOutboundHttp } from "./operations";

const redirectValue = (value: RequestInit): Option.Option<string> =>
  Option.fromUndefinedOr(value.redirect);

it.effect(
  "keeps authenticated media lookup and credential-free signed download on fixed Kapso destinations",
  () =>
    Effect.gen(function* () {
      const observed: Array<
        Readonly<{ url: string; key: Option.Option<string>; redirect: Option.Option<string> }>
      > = [];
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          const context = yield* Effect.context<never>();
          const init = Context.getOption(context, FetchHttpClient.RequestInit);
          observed.push({
            url: request.url,
            key: Option.fromUndefinedOr(request.headers["x-api-key"]),
            redirect: Option.flatMap(init, redirectValue),
          });
          return HttpClientResponse.fromWeb(request, new Response("bounded bytes"));
        })
      );
      const outbound = makeKapsoOutboundHttp({
        apiKey: Redacted.make("synthetic-media-key"),
        httpClient: client,
      });
      yield* outbound.execute({
        _tag: "KapsoMediaMetadata",
        mediaId: WhatsAppMediaId.make("media/../123"),
        businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("12345"),
      });
      yield* outbound.execute({
        _tag: "KapsoMediaDownload",
        token: Redacted.make("signed-token/&credential"),
      });
      expect(observed).toEqual([
        {
          url: "https://api.kapso.ai/meta/whatsapp/v24.0/media%2F..%2F123?phone_number_id=12345",
          key: Option.some("synthetic-media-key"),
          redirect: Option.some("manual"),
        },
        {
          url: "https://api.kapso.ai/meta/whatsapp/media_download?token=signed-token%2F%26credential",
          key: Option.none(),
          redirect: Option.some("manual"),
        },
      ]);
    })
);
