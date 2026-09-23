import type { Option } from "effect";
import type { AccessTier } from "~/core/access-tier/contract";
import type { ProviderQualifiedMessages } from "~/core/consent/model";
import type { CanonicalCaller } from "./authz";

/** Caller facts supplied to every canonical implementation once the executor has resolved one. */
export type CanonicalImplementationCaller = Readonly<{
  resolved: CanonicalCaller;
  accessTier: AccessTier;
  /** Exact provider evidence exposed lazily only after the hosted confirmation permit is consumed. */
  confirmationEvidence: () => Option.Option<ProviderQualifiedMessages>;
}>;
