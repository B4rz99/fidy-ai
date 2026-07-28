import { Config } from "effect";

/**
 * Stable public addresses shared by the web, channel, ingestion, and billing adapters.
 * Origins may be overridden for previews or local development; route paths remain one
 * product-level contract so dependent adapters cannot drift onto parallel callback URLs.
 */
export interface ExternalEndpoints {
  readonly webOrigin: string;
  readonly apiOrigin: string;
  readonly policyUrl: string;
  readonly magicLinkUrl: string;
  readonly kapsoWebhookUrl: string;
  readonly wompiCallbackUrl: string;
  readonly ingestDomain: string;
}

/**
 * Loads Fidy's public namespace from required process configuration. Missing or malformed
 * values fail before a dependent adapter can advertise an unusable external address.
 */
export const externalEndpoints: Config.Config<ExternalEndpoints> = Config.all({
  webOrigin: Config.url("PUBLIC_WEB_ORIGIN"),
  apiOrigin: Config.url("PUBLIC_API_ORIGIN"),
  ingestDomain: Config.nonEmptyString("INGEST_EMAIL_DOMAIN"),
}).pipe(
  Config.map(({ apiOrigin, ingestDomain, webOrigin }) => ({
    webOrigin: webOrigin.origin,
    apiOrigin: apiOrigin.origin,
    policyUrl: new URL("/politica", webOrigin).href,
    magicLinkUrl: new URL("/auth/magic", webOrigin).href,
    kapsoWebhookUrl: new URL("/webhooks/kapso", apiOrigin).href,
    wompiCallbackUrl: new URL("/webhooks/wompi", apiOrigin).href,
    ingestDomain,
  }))
);
