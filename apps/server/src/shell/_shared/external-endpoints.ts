import { Config, Schema } from "effect";
import { isHttpOrigin } from "~/http-origin";

/**
 * Stable public addresses shared by the web, channel, ingestion, and billing adapters.
 * Origins may be overridden for previews or local development; route paths remain one
 * product-level contract so dependent adapters cannot drift onto parallel callback URLs.
 */
export type ExternalEndpoints = {
  readonly webOrigin: string;
  readonly apiOrigin: string;
  readonly policyUrl: string;
  readonly upgradeUrl: string;
  readonly magicLinkUrl: string;
  readonly kapsoWebhookUrl: string;
  readonly wompiCallbackUrl: string;
  readonly ingestDomain: string;
};

const HttpOrigin = Schema.URL.check(
  Schema.makeFilter((url) =>
    isHttpOrigin(url)
      ? undefined
      : "Expected an HTTP origin without credentials, path, query, or fragment"
  )
);

/**
 * Loads Fidy's public namespace from required process configuration. Missing or malformed
 * values fail before a dependent adapter can advertise an unusable external address.
 */
export const externalEndpoints: Config.Config<ExternalEndpoints> = Config.all({
  webOrigin: Config.schema(HttpOrigin, "PUBLIC_WEB_ORIGIN"),
  apiOrigin: Config.schema(HttpOrigin, "PUBLIC_API_ORIGIN"),
  ingestDomain: Config.nonEmptyString("INGEST_EMAIL_DOMAIN"),
}).pipe(
  Config.map(({ apiOrigin, ingestDomain, webOrigin }) => ({
    webOrigin: webOrigin.origin,
    apiOrigin: apiOrigin.origin,
    policyUrl: new URL("/politica", webOrigin).href,
    upgradeUrl: new URL("/upgrade", webOrigin).href,
    magicLinkUrl: new URL("/auth/magic", webOrigin).href,
    kapsoWebhookUrl: new URL("/webhooks/kapso", apiOrigin).href,
    wompiCallbackUrl: new URL("/webhooks/wompi", apiOrigin).href,
    ingestDomain,
  }))
);
