import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Config, Effect, Layer } from "effect";
import { edgeSecurityPolicy } from "./edge-security";
import { marketingSite } from "./marketing-site";

const edgeSecurity = Effect.gen(function* () {
  const zone = yield* Cloudflare.Zone.Zone("ProductionZone", { name: "fidyapp.com" }).pipe(
    Alchemy.AdoptPolicy.adopt(true)
  );

  yield* Cloudflare.Zone.Setting("StrictTransportSecurity", {
    zoneId: zone.zoneId,
    settingId: "security_header",
    value: edgeSecurityPolicy.hsts,
  });

  const { customFirewall, httpDdos, managedFirewall, rateLimits } = edgeSecurityPolicy.rulesets;

  yield* Cloudflare.Ruleset.Ruleset(customFirewall.logicalId, {
    description: "Fidy host and public-ingress method allowlist",
    phase: customFirewall.phase,
    rules: [...customFirewall.rules],
    zone,
  });
  yield* Cloudflare.Ruleset.Ruleset(managedFirewall.logicalId, {
    description: "Fidy managed application WAF baseline",
    phase: managedFirewall.phase,
    rules: [...managedFirewall.rules],
    zone,
  });
  yield* Cloudflare.Ruleset.Ruleset(httpDdos.logicalId, {
    description: "Fidy always-on non-interactive HTTP DDoS baseline",
    phase: httpDdos.phase,
    rules: [...httpDdos.rules],
    zone,
  });
  yield* Cloudflare.Ruleset.Ruleset(rateLimits.logicalId, {
    description: "Fidy operation-aware public edge limits",
    phase: rateLimits.phase,
    rules: [...rateLimits.rules],
    zone,
  });
});

export default Alchemy.Stack(
  "FidyCloudflare",
  {
    providers: Cloudflare.providers(),
    state: Layer.unwrap(
      Effect.map(Alchemy.Stage, (stage) =>
        stage === "production" ? Cloudflare.state() : Alchemy.inMemoryState()
      )
    ),
  },
  Effect.gen(function* () {
    yield* edgeSecurity;
    const site = yield* marketingSite(yield* Config.String("RELEASE_GIT_SHA"), true);

    return { siteUrl: site.url };
  })
);
