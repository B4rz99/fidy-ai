import { expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";
import {
  OperationAccess,
  type OperationAccessCaller,
  completesHostedTurn,
  decideOperationAccess,
  freshWebSessionOnly,
  isHostedVisible,
  isPATScoped,
  patScopeCapability,
  patScoped,
  patScopedChildren,
  publishOperationAccess,
  verifiedWhatsAppHostedOnly,
  webOrHosted,
} from "./operation-policy";

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
        type: "pat-scoped",
        scope: { evaluation: "operation", capability: "write" },
      },
      canonical: patScoped("write"),
    },
    {
      published: { type: "pat-scoped", scope: { evaluation: "children" } },
      canonical: patScopedChildren,
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
  ] as const;

  for (const { published, canonical } of examples) {
    expect(Schema.decodeUnknownSync(OperationAccess)(published)).toEqual(canonical);
    expect(publishOperationAccess(canonical)).toEqual(published);
  }
});

it("decides every canonical caller class from one access requirement", () => {
  expect(decideOperationAccess(patScoped("read"), pat(["read"]))).toEqual({ _tag: "Allowed" });
  expect(decideOperationAccess(patScoped("read"), pat(["write"]))).toEqual({
    _tag: "Denied",
    reason: "pat_scope_missing",
  });
  expect(decideOperationAccess(patScopedChildren, pat([]))).toEqual({ _tag: "Allowed" });
  expect(decideOperationAccess(patScoped("dashboard"), web(false))).toEqual({ _tag: "Allowed" });
  expect(decideOperationAccess(patScoped("write"), hosted("verified-whatsapp"))).toEqual({
    _tag: "Allowed",
  });

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
});

it("derives PAT and hosted discovery from the same access requirement", () => {
  expect(isPATScoped(patScoped("read"))).toBe(true);
  expect(isPATScoped(freshWebSessionOnly)).toBe(false);
  expect(isPATScoped(webOrHosted)).toBe(false);
  expect(isPATScoped(verifiedWhatsAppHostedOnly)).toBe(false);

  expect(Option.getOrUndefined(patScopeCapability(patScoped("dashboard")))).toBe("dashboard");
  expect(Option.isNone(patScopeCapability(patScopedChildren))).toBe(true);
  expect(Option.isNone(patScopeCapability(freshWebSessionOnly))).toBe(true);

  expect(isHostedVisible(patScoped("read"), "verified-whatsapp")).toBe(true);
  expect(isHostedVisible(freshWebSessionOnly, "verified-whatsapp")).toBe(false);
  expect(isHostedVisible(webOrHosted, "verified-whatsapp")).toBe(true);
  expect(isHostedVisible(verifiedWhatsAppHostedOnly, "verified-whatsapp")).toBe(true);
  expect(isHostedVisible(verifiedWhatsAppHostedOnly, "no-verified-whatsapp-authority")).toBe(false);
});

it("derives hosted turn completion without a separate operation allowlist", () => {
  const mutationPolicy = {
    requiredTier: "free",
    agentConfirmation: "not-required",
    kind: "mutation",
  } as const;

  expect(completesHostedTurn({ ...mutationPolicy, access: patScoped("write") })).toBe(true);
  expect(completesHostedTurn({ ...mutationPolicy, access: patScoped("read") })).toBe(false);
  expect(completesHostedTurn({ ...mutationPolicy, access: patScopedChildren })).toBe(false);
  expect(completesHostedTurn({ ...mutationPolicy, access: verifiedWhatsAppHostedOnly })).toBe(true);
  expect(completesHostedTurn({ ...mutationPolicy, access: freshWebSessionOnly })).toBe(false);
});
