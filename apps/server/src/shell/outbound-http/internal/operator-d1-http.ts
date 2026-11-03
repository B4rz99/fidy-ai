import { Effect, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpBody, type HttpClient, HttpClientRequest } from "effect/http";
import { type OperatorD1HttpService, OutboundHttpFailure } from "~/shell/outbound-http/contract";
import { makeProviderTransport } from "./transport";

const Configuration = Schema.Struct({
  accountId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)),
  databaseId: Schema.String.check(Schema.isUUID()),
});
const maximumResponseBytes = 262144;
const maximumRequestBytes = 8192;
const unavailable = (): OutboundHttpFailure =>
  new OutboundHttpFailure({
    reason: "invalid-destination",
    responseStatus: Option.none(),
    responseHeaders: {},
  });

/** Native operator configuration fixes the sole database destination and admin credential. */
export const operatorD1Http = (
  input: Readonly<{
    accountId: string;
    databaseId: string;
    token: Redacted.Redacted<string>;
    client: HttpClient.HttpClient;
  }>
): OperatorD1HttpService => {
  const configured = Schema.decodeOption(Configuration)(input);
  const http = makeProviderTransport("cloudflare-d1")(input.client);
  return {
    execute: (body) => {
      if (
        Option.isNone(configured) ||
        Redacted.value(input.token).length === 0 ||
        new TextEncoder().encode(body).length > maximumRequestBytes
      ) {
        return Effect.fail(unavailable());
      }
      const { accountId, databaseId } = configured.value;
      return http
        .execute(
          HttpClientRequest.post(
            `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
            {
              headers: {
                authorization: `Bearer ${Redacted.value(input.token)}`,
                "content-type": "application/json",
              },
              body: HttpBody.text(body, "application/json"),
            }
          ),
          maximumResponseBytes
        )
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, {
            credentials: "omit",
            redirect: "error",
          }),
          Effect.timeout("15 seconds"),
          Effect.mapError(() => unavailable())
        );
    },
  };
};
