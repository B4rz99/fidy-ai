import { Config, Effect } from "effect";
import { verifyIncumbentFence, verifyIncumbentMail } from "./native-incumbent-fence";
import type { ProviderRead } from "./native-provider-list";

const api = "https://api.cloudflare.com/client/v4/";
const reader =
  (scope: string, token: string): ProviderRead =>
  (path) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(api + scope + path, {
          headers: { authorization: "Bearer " + token },
          redirect: "error",
          signal,
        });
        if (!response.ok) throw Error("Incumbent fence provider read refused");
        const payload: unknown = await response.json();
        return payload;
      },
      catch: () => Error("Incumbent fence provider read failed"),
    }).pipe(
      Effect.timeout("20 seconds"),
      Effect.mapError(() => Error("Incumbent fence unavailable"))
    );

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
  const token = yield* Config.String("CLOUDFLARE_API_TOKEN");
  if (![account, zone].every((id) => /^[a-f0-9]{32}$/u.test(id)) || token === "") {
    return yield* Effect.fail(Error("Exact incumbent retirement provider coordinates required"));
  }
  const accountRead = reader("accounts/" + account + "/", token);
  const zoneRead = reader("zones/" + zone + "/", token);
  const evidence = yield* verifyIncumbentFence(accountRead, { partialRetirement: true });
  yield* verifyIncumbentMail(accountRead, zoneRead, { nativeClosed: false });
  return evidence;
});

if (import.meta.main) {
  try {
    const evidence = await Effect.runPromise(fence);
    console.log(JSON.stringify(evidence));
  } catch {
    console.error("Protected incumbent writer and Email fence verification refused");
    process.exitCode = 1;
  }
}
