import { operationCatalog } from "@fidy/server/canonical-runtime";
import {
  emailReplacementCompletionPath,
  emailReplacementPath,
} from "@fidy/server/email-replacement-path";
import { statementStagingPath } from "@fidy/server/statement-path";
import type * as Cloudflare from "alchemy/Cloudflare";
import { browserOrigins, productionTopology } from "../../apps/server/cloudflare/runtime/topology";

const kapsoCallbackPath = "/providers/kapso/callback";
const wompiCallbackPath = "/providers/wompi/callback";
const cloudflareFreeManagedRulesetId = "77454fe2d30c4220b5701f6fdfb893ba";
const cloudflareHttpDdosRulesetId = "4d21379b4f9f4bb088e0729962c8b3cf";
const freePlanRateLimitPeriod = 10;
const freePlanRequestsPerPeriod = 60;
const apiHostname = productionTopology.ingress.hostname;
const ownedHostnames = [
  ...productionTopology.web.redirects,
  productionTopology.web.hostname,
  apiHostname,
];
const ownedHostExpression = ownedHostnames.map((hostname) => `"${hostname}"`).join(" ");

const reservedIngress = {
  emailEvent: {
    event: "cloudflare-email-worker",
    proof: "cloudflare-email-routing-and-replay",
    provider: "cloudflare-email",
  },
  httpCallbacks: {
    kapso: {
      path: kapsoCallbackPath,
      proof: "kapso-signature-and-replay",
      provider: "kapso",
    },
    wompi: {
      path: wompiCallbackPath,
      proof: "wompi-signature-and-replay",
      provider: "wompi",
    },
  },
} as const;

const customFirewallRules: ReadonlyArray<Cloudflare.Ruleset.Rule> = [
  {
    action: "skip",
    actionParameters: {
      phases: ["http_request_sbfm"],
      products: ["bic", "hot", "securityLevel", "uaBlock", "zoneLockdown"],
    },
    description: "Keep API and callback callers free of interactive security products",
    enabled: true,
    expression: `(http.host eq "${apiHostname}")`,
  },
  {
    action: "block",
    description: "Reject hosts outside the owned Fidy production surface",
    enabled: true,
    expression: `not http.host in {${ownedHostExpression}}`,
  },
  {
    action: "block",
    description: "Reject methods not owned by the public API ingress",
    enabled: true,
    expression: `(http.host eq "${apiHostname}" and not (http.request.method in {"GET" "POST" "OPTIONS" "DELETE" "PUT" "PATCH"}))`,
  },
];

const managedFirewallRules: ReadonlyArray<Cloudflare.Ruleset.Rule> = [
  {
    action: "execute",
    actionParameters: {
      // The Free Managed Ruleset is available on the launch zone's plan. Its defaults provide
      // non-interactive enforcement; plan-specific overrides are not sent here.
      id: cloudflareFreeManagedRulesetId,
    },
    description: "Execute the Cloudflare Free Managed Ruleset",
    enabled: true,
    expression: "true",
  },
];

const httpDdosRules: ReadonlyArray<Cloudflare.Ruleset.Rule> = [
  {
    action: "execute",
    actionParameters: {
      id: cloudflareHttpDdosRulesetId,
      overrides: { action: "block", sensitivityLevel: "default" },
    },
    description: "Keep always-on HTTP DDoS mitigation non-interactive",
    enabled: true,
    expression: "true",
  },
];

// The Free plan permits one path-based rule. Static paths and parameterized route prefixes derive
// from the canonical API; unmatched paths never charge legitimate callers' shared source-IP budget.
const reservedRateLimitPaths = [
  "/health",
  reservedIngress.httpCallbacks.kapso.path,
  reservedIngress.httpCallbacks.wompi.path,
  "/web/onboarding/email/verify",
  "/web/pairings",
  "/web/pairings/redeem",
  "/web/session/logout",
  "/web/email/authentication/start",
  "/web/email/authentication/complete",
  emailReplacementPath,
  emailReplacementCompletionPath,
  "/recovery/backup-code/rotate",
  "/internal/support-recovery",
  "/user",
  "/pat-pairings",
  "/pat-pairings/claim",
  statementStagingPath,
] as const;
const declaredRoutes = operationCatalog.operations.map((operation) => operation.route);
const exactPaths = Array.from(
  new Set([...reservedRateLimitPaths, ...declaredRoutes.filter((route) => !route.includes(":"))])
).sort();
const paramPrefixes = Array.from(
  new Set(
    declaredRoutes
      .filter((route) => route.includes(":"))
      .map((route) => route.slice(0, route.indexOf(":")))
  )
).sort();
const rateLimitExpression = `http.request.uri.path in {${exactPaths.map((path) => `"${path}"`).join(" ")}}${paramPrefixes
  .map((prefix) => ` or starts_with(http.request.uri.path, "${prefix}")`)
  .join("")}`;

const rateLimitRules: ReadonlyArray<Cloudflare.Ruleset.Rule> = [
  {
    action: "block",
    description: "Bound public and provider ingress by source IP",
    enabled: true,
    expression: rateLimitExpression,
    ratelimit: {
      characteristics: ["cf.colo.id", "ip.src"],
      mitigationTimeout: freePlanRateLimitPeriod,
      period: freePlanRateLimitPeriod,
      requestsPerPeriod: freePlanRequestsPerPeriod,
    },
  },
];

/**
 * Production edge manifest consumed by Alchemy and release verification. It derives owned
 * hostnames from the topology authority and records the proof/replay owner for each reserved
 * machine ingress. Every enforcement action is non-interactive; no challenge rule exists.
 */
export const edgeSecurityPolicy = {
  browserOrigin: browserOrigins.production,
  reservedIngress,
  rulesets: {
    customFirewall: {
      logicalId: "CustomFirewall",
      phase: "http_request_firewall_custom",
      rules: customFirewallRules,
    },
    httpDdos: { logicalId: "HttpDdos", phase: "ddos_l7", rules: httpDdosRules },
    managedFirewall: {
      logicalId: "ManagedFirewall",
      phase: "http_request_firewall_managed",
      rules: managedFirewallRules,
    },
    rateLimits: {
      logicalId: "RateLimits",
      phase: "http_ratelimit",
      rules: rateLimitRules,
    },
  },
} as const;
