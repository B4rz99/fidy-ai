import type { CanonicalCaller } from "./contract";
import type { OperationAccessCaller } from "~/shell/canonical-policy/contract";

/** Projects attributable authority into the identity-free facts consumed by access policy. */
export const toAccessCaller = (caller: CanonicalCaller): OperationAccessCaller => {
  if (caller.auditCaller._tag === "PAT" || caller.auditCaller._tag === "OAuthAgent") {
    return { _tag: caller.auditCaller._tag, capabilities: caller.capabilities };
  }
  if ("fresh" in caller) {
    return { _tag: "WebSession", fresh: caller.fresh };
  }
  return { _tag: "HostedAgentSession", authorityRoot: caller.authorityRoot };
};
