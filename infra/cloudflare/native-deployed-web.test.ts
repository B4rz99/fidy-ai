import { installedOrigins } from "@fidy/server/browser-transport";
import { expect, it } from "vitest";
import { installedHeaders } from "./native-deployed-web";

type VerifiedHeaders = Readonly<{
  "content-security-policy": string;
  link: string;
  "x-content-type-options": string;
}>;

const canonicalConnect =
  "https://api.fidyapp.com https://sandbox.wompi.co https://production.wompi.co https://api-sandbox.wompi.co/v1/webhook_events/daviplata_response/sandbox";

const verifiedHeaders = (api: string, connect: string): VerifiedHeaders => ({
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; connect-src " + connect,
  link: "<" + api + ">; rel=preconnect; crossorigin=use-credentials",
  "x-content-type-options": "nosniff",
});

it("requires the exact reviewed connect policy for the closed staged browser hosts", () => {
  const { production, acceptance } = installedOrigins;
  expect(
    installedHeaders({
      headers: verifiedHeaders(production.api, canonicalConnect),
      origins: production,
    })
  ).toBe(true);
  expect(
    installedHeaders({
      headers: verifiedHeaders(production.api, production.api),
      origins: production,
    })
  ).toBe(false);
  expect(
    installedHeaders({
      headers: verifiedHeaders(production.api, canonicalConnect + " https://other.invalid"),
      origins: production,
    })
  ).toBe(false);
  expect(
    installedHeaders({
      headers: verifiedHeaders(acceptance.api, acceptance.api),
      origins: acceptance,
    })
  ).toBe(true);
  expect(
    installedHeaders({
      headers: verifiedHeaders(acceptance.api, canonicalConnect),
      origins: acceptance,
    })
  ).toBe(false);
});
