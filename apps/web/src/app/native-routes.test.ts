import { Option } from "effect";
import { fromString } from "foldkit/url";
import { expect, it } from "vitest";
import { parseAppRoute } from "./native-routes";

const parse = (path: string): ReturnType<typeof parseAppRoute> =>
  parseAppRoute(Option.getOrThrow(fromString(`https://app.fidyapp.com${path}`)));

it.each([
  ["/", "Home"],
  ["/politica", "Privacy"],
  ["/cookies", "Cookies"],
  ["/terminos", "Terms"],
  ["/auth/pair", "Pair"],
  ["/auth/google", "Google"],
  ["/auth/microsoft", "Microsoft"],
  ["/auth/google-return", "GoogleReturn"],
  ["/auth/microsoft-return", "MicrosoftReturn"],
  ["/connect/cli", "CLI"],
  ["/connections/continue", "Connections"],
  ["/upgrade", "Upgrade"],
  ["/app", "AppIndex"],
  ["/app/dashboard", "Dashboard"],
  ["/app/transactions", "Transactions"],
  ["/settings/pats", "PATs"],
  ["/settings/agents", "Agents"],
  ["/settings/email", "Email"],
  ["/settings/recovery", "Recovery"],
])("matches %s without confusing parent routes", (path, tag) => {
  expect(parse(path)._tag).toBe(tag);
});
it.each(["transacciones", "presupuestos", "asistente", "tablero", "insights", "agentes"])(
  "matches the public %s detail page",
  (slug) => expect(parse(`/funciones/${slug}`)).toEqual({ _tag: "Feature", slug })
);
it("keeps canonical public references and drops unknown query data", () => {
  const reference = "10000000-0000-4000-8000-000000000001";
  expect(parse(`/connections/continue?attempt=${reference}&privateVerifier=secret`)).toEqual({
    _tag: "Connections",
    attempt: Option.some(reference),
  });
  expect(parse(`/oauth/review/${reference}`)).toEqual({
    _tag: "OAuthReview",
    requestId: reference,
  });
  expect(parse(`/auth/pair?connectionAttempt=${reference}&privateVerifier=secret`)).toEqual({
    _tag: "Pair",
    connectionAttempt: Option.some(reference),
    oauthRequest: Option.none(),
    cliCode: Option.none(),
  });
});
it("preserves the invalid connection review without retaining malformed input", () => {
  expect(parse("/connections/continue?attempt=invalid")).toEqual({
    _tag: "Connections",
    attempt: Option.none(),
  });
});
it.each([
  "/missing?privateVerifier=secret",
  "/funciones/missing",
  "/oauth/review/invalid",
  "/app/dashboard/extra",
])("rejects %s while keeping query data out of the fallback model", (path) => {
  expect(parse(path)).toEqual({ _tag: "NotFound", path: path.split("?")[0] });
});
