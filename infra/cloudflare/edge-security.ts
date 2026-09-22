import { listCategoriesPath } from "@fidy/server/categories-path";
import type * as Cloudflare from "alchemy/Cloudflare";
import { browserOrigins, productionTopology } from "./topology";

const kapsoCallbackPath = "/providers/kapso/callback";
const wompiCallbackPath = "/providers/wompi/callback";
const cloudflareManagedRulesetId = "efb7b8c949ac4650a09736fc376e9aee";
const cloudflareHttpDdosRulesetId = "4d21379b4f9f4bb088e0729962c8b3cf";
const healthRequestsPerPeriod = 60;
const canonicalReadRequestsPerPeriod = 120;
const providerCallbackRequestsPerPeriod = 60;
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
    expression: `(http.host eq "${apiHostname}" and not http.request.method in {"GET" "POST" "OPTIONS"})`,
  },
];

const managedFirewallRules: ReadonlyArray<Cloudflare.Ruleset.Rule> = [
  {
    action: "execute",
    actionParameters: {
      id: cloudflareManagedRulesetId,
      // Preserve Cloudflare's enabled-rule selection while ensuring a WAF decision blocks rather
      // than presenting a browser challenge to machine callers.
      overrides: { action: "block" },
    },
    description: "Execute Cloudflare managed WAF rules with non-interactive enforcement",
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

type RateLimitPolicy = {
  readonly description: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly requestsPerPeriod: number;
};

const rateLimitRule = ({
  description,
  method,
  path,
  requestsPerPeriod,
}: RateLimitPolicy): Cloudflare.Ruleset.Rule => ({
  action: "block",
  description,
  enabled: true,
  expression: `(http.host eq "${apiHostname}" and http.request.method eq "${method}" and http.request.uri.path eq "${path}")`,
  ratelimit: {
    characteristics: ["cf.colo.id", "ip.src"],
    mitigationTimeout: 10,
    period: 10,
    requestsPerPeriod,
  },
});

const rateLimitRules: ReadonlyArray<Cloudflare.Ruleset.Rule> = [
  rateLimitRule({
    description: "Bound public health probes per network source",
    method: "GET",
    path: "/health",
    requestsPerPeriod: healthRequestsPerPeriod,
  }),
  rateLimitRule({
    description: "Bound Categories reads per network source without inspecting bearer material",
    method: "GET",
    path: listCategoriesPath,
    requestsPerPeriod: canonicalReadRequestsPerPeriod,
  }),
  rateLimitRule({
    description: "Reserve an independent Kapso callback budget",
    method: "POST",
    path: reservedIngress.httpCallbacks.kapso.path,
    requestsPerPeriod: providerCallbackRequestsPerPeriod,
  }),
  rateLimitRule({
    description: "Reserve an independent Wompi callback budget",
    method: "POST",
    path: reservedIngress.httpCallbacks.wompi.path,
    requestsPerPeriod: providerCallbackRequestsPerPeriod,
  }),
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
