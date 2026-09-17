import type { WompiEnvironment } from "~/core/subscription/model";

/** Public prefixes needed by Subscription for one Wompi environment. */
export type WompiCredentialPrefixes = Readonly<{
  readonly publicKey: string;
  readonly eventSecret: string;
}>;

const prefixesByEnvironment = {
  sandbox: {
    publicKey: "pub_test_",
    eventSecret: "test_events_",
  },
  production: {
    publicKey: "pub_prod_",
    eventSecret: "prod_events_",
  },
} as const satisfies Readonly<Record<WompiEnvironment, WompiCredentialPrefixes>>;

/**
 * One environment → prefix table for Subscription-owned public enrollment and webhook credentials.
 * The prefixes are public, not Secrets, and catch values issued for the other environment.
 */
export const wompiCredentialPrefixes = (environment: WompiEnvironment): WompiCredentialPrefixes =>
  prefixesByEnvironment[environment];
