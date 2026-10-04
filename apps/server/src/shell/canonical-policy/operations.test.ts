import { expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";
import {
  OperationAccess,
  type OperationAccessCaller,
  freshWebOrVerifiedWhatsAppHosted,
  freshWebSessionOnly,
  isUserOwnedAgentScoped,
  publishOperationAccess,
  userOwnedAgentCapability,
  userOwnedAgentScoped,
  userOwnedAgentScopedChildren,
  verifiedWhatsAppHostedOnly,
  webOrHosted,
} from "./contract";
import { completesHostedTurn, decideOperationAccess, isHostedVisible } from "./operations";

const pat = (
  capabilities: ReadonlyArray<"read" | "write" | "dashboard">
): OperationAccessCaller => ({ _tag: "PAT", capabilities });
const web = (fresh: boolean): OperationAccessCaller => ({ _tag: "WebSession", fresh });
const hosted = (
  authorityRoot: "verified-whatsapp" | "no-verified-whatsapp-authority"
): OperationAccessCaller => ({ _tag: "HostedAgentSession", authorityRoot });

it("round-trips every published access variant through the canonical codec", () => {
  const examples = [
    {
      published: {
        type: "user-owned-agent-scoped",
        scope: { evaluation: "operation", capability: "write" },
      },
      canonical: userOwnedAgentScoped("write"),
    },
    {
      published: { type: "user-owned-agent-scoped", scope: { evaluation: "children" } },
      canonical: userOwnedAgentScopedChildren,
    },
    {
      published: { type: "fresh-web-session-only" },
      canonical: freshWebSessionOnly,
    },
    { published: { type: "web-or-hosted" }, canonical: webOrHosted },
    {
      published: { type: "verified-whatsapp-hosted-only" },
      canonical: verifiedWhatsAppHostedOnly,
    },
    {
      published: { type: "fresh-web-or-verified-whatsapp-hosted" },
      canonical: freshWebOrVerifiedWhatsAppHosted,
    },
  ] as const;

  for (const { published, canonical } of examples) {
    expect(Schema.decodeSync(OperationAccess)(published)).toEqual(canonical);
    expect(publishOperationAccess(canonical)).toEqual(published);
  }
});

it("decides every canonical caller class from one access requirement", () => {
  expect(decideOperationAccess(userOwnedAgentScoped("read"), pat(["read"]))).toEqual({
    _tag: "Allowed",
  });
  expect(decideOperationAccess(userOwnedAgentScoped("read"), pat(["write"]))).toEqual({
    _tag: "Denied",
    reason: "user_owned_agent_scope_missing",
  });
  expect(decideOperationAccess(userOwnedAgentScopedChildren, pat([]))).toEqual({ _tag: "Allowed" });
  expect(decideOperationAccess(userOwnedAgentScoped("dashboard"), web(false))).toEqual({
    _tag: "Allowed",
  });
  expect(decideOperationAccess(userOwnedAgentScoped("write"), hosted("verified-whatsapp"))).toEqual(
    {
      _tag: "Allowed",
    }
  );

  expect(decideOperationAccess(freshWebSessionOnly, web(true))).toEqual({ _tag: "Allowed" });
  expect(decideOperationAccess(freshWebSessionOnly, web(false))).toEqual({
    _tag: "Denied",
    reason: "fresh_web_session_required",
  });
  expect(decideOperationAccess(freshWebSessionOnly, pat(["write"]))).toEqual({
    _tag: "Denied",
    reason: "caller_ineligible",
  });

  expect(decideOperationAccess(webOrHosted, web(false))).toEqual({ _tag: "Allowed" });
  expect(decideOperationAccess(webOrHosted, hosted("no-verified-whatsapp-authority"))).toEqual({
    _tag: "Allowed",
  });
  expect(decideOperationAccess(webOrHosted, pat(["read", "write", "dashboard"]))).toEqual({
    _tag: "Denied",
    reason: "caller_ineligible",
  });

  expect(decideOperationAccess(verifiedWhatsAppHostedOnly, hosted("verified-whatsapp"))).toEqual({
    _tag: "Allowed",
  });
  expect(
    decideOperationAccess(verifiedWhatsAppHostedOnly, hosted("no-verified-whatsapp-authority"))
  ).toEqual({ _tag: "Denied", reason: "caller_ineligible" });
  expect(decideOperationAccess(verifiedWhatsAppHostedOnly, web(true))).toEqual({
    _tag: "Denied",
    reason: "caller_ineligible",
  });

  expect(decideOperationAccess(freshWebOrVerifiedWhatsAppHosted, web(true))).toEqual({
    _tag: "Allowed",
  });
  expect(decideOperationAccess(freshWebOrVerifiedWhatsAppHosted, web(false))).toEqual({
    _tag: "Denied",
    reason: "fresh_web_session_required",
  });
  expect(
    decideOperationAccess(freshWebOrVerifiedWhatsAppHosted, hosted("verified-whatsapp"))
  ).toEqual({ _tag: "Allowed" });
  expect(
    decideOperationAccess(
      freshWebOrVerifiedWhatsAppHosted,
      hosted("no-verified-whatsapp-authority")
    )
  ).toEqual({ _tag: "Denied", reason: "caller_ineligible" });
  expect(decideOperationAccess(freshWebOrVerifiedWhatsAppHosted, pat(["write"]))).toEqual({
    _tag: "Denied",
    reason: "caller_ineligible",
  });
});

it("derives PAT and hosted discovery from the same access requirement", () => {
  expect(isUserOwnedAgentScoped(userOwnedAgentScoped("read"))).toBe(true);
  expect(isUserOwnedAgentScoped(freshWebSessionOnly)).toBe(false);
  expect(isUserOwnedAgentScoped(webOrHosted)).toBe(false);
  expect(isUserOwnedAgentScoped(verifiedWhatsAppHostedOnly)).toBe(false);
  expect(isUserOwnedAgentScoped(freshWebOrVerifiedWhatsAppHosted)).toBe(false);

  expect(Option.getOrUndefined(userOwnedAgentCapability(userOwnedAgentScoped("dashboard")))).toBe(
    "dashboard"
  );
  expect(Option.isNone(userOwnedAgentCapability(userOwnedAgentScopedChildren))).toBe(true);
  expect(Option.isNone(userOwnedAgentCapability(freshWebSessionOnly))).toBe(true);

  expect(isHostedVisible(userOwnedAgentScoped("read"), "verified-whatsapp")).toBe(true);
  expect(isHostedVisible(freshWebSessionOnly, "verified-whatsapp")).toBe(false);
  expect(isHostedVisible(webOrHosted, "verified-whatsapp")).toBe(true);
  expect(isHostedVisible(verifiedWhatsAppHostedOnly, "verified-whatsapp")).toBe(true);
  expect(isHostedVisible(verifiedWhatsAppHostedOnly, "no-verified-whatsapp-authority")).toBe(false);
  expect(isHostedVisible(freshWebOrVerifiedWhatsAppHosted, "verified-whatsapp")).toBe(true);
  expect(isHostedVisible(freshWebOrVerifiedWhatsAppHosted, "no-verified-whatsapp-authority")).toBe(
    false
  );
});

it("derives hosted turn completion without a separate operation allowlist", () => {
  const mutationPolicy = {
    requiredTier: "free",
    agentConfirmation: "not-required",
    kind: "mutation",
  } as const;

  expect(completesHostedTurn({ ...mutationPolicy, access: userOwnedAgentScoped("write") })).toBe(
    true
  );
  expect(completesHostedTurn({ ...mutationPolicy, access: userOwnedAgentScoped("read") })).toBe(
    false
  );
  expect(completesHostedTurn({ ...mutationPolicy, access: userOwnedAgentScopedChildren })).toBe(
    false
  );
  expect(completesHostedTurn({ ...mutationPolicy, access: verifiedWhatsAppHostedOnly })).toBe(true);
  expect(completesHostedTurn({ ...mutationPolicy, access: freshWebSessionOnly })).toBe(false);
  expect(completesHostedTurn({ ...mutationPolicy, access: freshWebOrVerifiedWhatsAppHosted })).toBe(
    true
  );
});
