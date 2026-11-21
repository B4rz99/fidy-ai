import type { Effect } from "effect";
import { installedOrigins } from "@fidy/server/browser-transport";
import { installationNames } from "./storage-installation";

export const canonicalDomains = [
  {
    host: new URL(installedOrigins.production.api).hostname,
    native: installationNames.Ingress,
  },
  {
    host: new URL(installedOrigins.production.browser).hostname,
    native: installationNames.Web,
  },
] as const;

export type CanonicalDomain = (typeof canonicalDomains)[number];

type DomainState =
  | Readonly<{ vacant: true }>
  | Readonly<{ vacant: false; id: string; service: string }>;

export type ReadCanonicalDomain = (domain: CanonicalDomain) => Effect.Effect<DomainState, Error>;
