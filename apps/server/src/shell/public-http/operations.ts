import { isHttpOrigin } from "~/shell/browser-transport/operations";
import { Config, Schema } from "effect";

export type ExternalEndpoints = {
  readonly webOrigin: string;
  readonly apiOrigin: string;
  readonly policyUrl: string;
  readonly upgradeUrl: string;
  readonly kapsoWebhookUrl: string;
  readonly wompiCallbackUrl: string;
};

const HttpOrigin = Schema.URL.check(
  Schema.makeFilter((url) =>
    isHttpOrigin(url)
      ? undefined
      : "Expected an HTTP origin without credentials, path, query, or fragment"
  )
);

export const externalEndpoints: Config.Config<ExternalEndpoints> = Config.all({
  webOrigin: Config.schema(HttpOrigin, "PUBLIC_WEB_ORIGIN"),
  apiOrigin: Config.schema(HttpOrigin, "PUBLIC_API_ORIGIN"),
}).pipe(
  Config.map(({ apiOrigin, webOrigin }) => ({
    webOrigin: webOrigin.origin,
    apiOrigin: apiOrigin.origin,
    policyUrl: new URL("/politica", webOrigin).href,
    upgradeUrl: new URL("/upgrade", webOrigin).href,
    kapsoWebhookUrl: new URL("/webhooks/kapso", apiOrigin).href,
    wompiCallbackUrl: new URL("/webhooks/wompi", apiOrigin).href,
  }))
);

export const matchesRouteTemplate = ({
  template,
  path,
}: Readonly<{ template: string; path: string }>): boolean => {
  const expected = template.split("/");
  const actual = path.split("/");

  return (
    expected.length === actual.length &&
    expected.every((segment, index) =>
      segment.startsWith(":") ? (actual[index]?.length ?? 0) > 0 : segment === actual[index]
    )
  );
};
