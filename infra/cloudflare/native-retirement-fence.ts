import { Config, Effect, type Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { releaseEvidence } from "./production-release";
import { ReleaseHttpLive } from "./release-http";
import { verifyIncumbentFence, verifyIncumbentMail } from "./native-incumbent-fence";
import type { ProviderRead } from "./native-provider-list";

const api = "https://api.cloudflare.com/client/v4/";
const reader =
  ({
    scope,
    token,
    client,
  }: Readonly<{
    scope: string;
    token: Redacted.Redacted<string>;
    client: HttpClient.HttpClient;
  }>): ProviderRead =>
  (path) =>
    releaseEvidence
      .providerJson(
        HttpClientRequest.get(api + scope + path).pipe(HttpClientRequest.bearerToken(token))
      )
      .pipe(Effect.provideService(HttpClient.HttpClient, client));

const fence = Effect.gen(function* () {
  yield* Config.Literal("true", "GITHUB_ACTIONS");
  yield* Config.Literal("true", "GITHUB_REF_PROTECTED");
  yield* Config.Literal("refs/heads/trunk", "GITHUB_REF");
  yield* Config.Literal("workflow_dispatch", "GITHUB_EVENT_NAME");
  yield* Config.Literal("B4rz99/fidy-ai", "GITHUB_REPOSITORY");
  yield* Config.Literal(
    "B4rz99/fidy-ai/.github/workflows/native-incumbent-retirement.yml@refs/heads/trunk",
    "GITHUB_WORKFLOW_REF"
  );
  const account = yield* Config.String("CLOUDFLARE_ACCOUNT_ID");
  const zone = yield* Config.String("INCUMBENT_RETIREMENT_ZONE");
  const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
  const client = yield* HttpClient.HttpClient;
  if (![account, zone].every((id) => /^[a-f0-9]{32}$/u.test(id))) {
    return yield* Effect.fail(Error("Exact incumbent retirement provider coordinates required"));
  }
  const accountRead = reader({ scope: "accounts/" + account + "/", token, client });
  const zoneRead = reader({ scope: "zones/" + zone + "/", token, client });
  const evidence = yield* verifyIncumbentFence(accountRead, { partialRetirement: true });
  yield* verifyIncumbentMail(accountRead, zoneRead, { nativeClosed: false });
  return evidence;
});

if (import.meta.main) {
  try {
    const evidence = await Effect.runPromise(fence.pipe(Effect.provide(ReleaseHttpLive)));
    await Bun.write(Bun.stdout, releaseEvidence.encodeJson(evidence) + "\n");
  } catch {
    await Bun.write(
      Bun.stderr,
      "Protected incumbent writer and Email fence verification refused\n"
    );
    process.exitCode = 1;
  }
}
