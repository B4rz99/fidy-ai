import { Effect, Match, Option, Schema, pipe } from "effect";
import { Route } from "foldkit";
import { defineRouteUnion } from "foldkit/route";
import type { Url } from "foldkit/url";
import {
  ConnectionAttemptReference,
  OAuthConnectionId,
  OAuthRequestId,
  PATPairingPublicCode,
  ProviderHandoffSearch,
  RecurringDigestReportParams,
} from "@/transport/client";

const providerSearch = {
  handoff: Schema.Option(ProviderHandoffSearch.fields.handoff.schema),
  cliCode: Schema.Option(PATPairingPublicCode),
};
const providerQuery = Schema.Struct({
  handoff: Schema.OptionFromOptionalKey(ProviderHandoffSearch.fields.handoff.schema),
  cliCode: Schema.OptionFromOptionalKey(PATPairingPublicCode),
});
const pairingQuery = Schema.Struct({
  cliCode: Schema.OptionFromOptionalKey(PATPairingPublicCode),
  oauthRequest: Schema.OptionFromOptionalKey(OAuthRequestId),
  connectionAttempt: Schema.OptionFromOptionalKey(ConnectionAttemptReference),
});
export const AppRoute = defineRouteUnion({
  Home: {},
  Privacy: {},
  Cookies: {},
  Terms: {},
  Feature: {
    slug: Schema.Literals([
      "transacciones",
      "presupuestos",
      "asistente",
      "tablero",
      "insights",
      "agentes",
    ]),
  },
  Pair: {
    cliCode: Schema.Option(PATPairingPublicCode),
    oauthRequest: Schema.Option(OAuthRequestId),
    connectionAttempt: Schema.Option(ConnectionAttemptReference),
  },
  Google: providerSearch,
  Microsoft: providerSearch,
  GoogleReturn: {},
  MicrosoftReturn: {},
  CLI: {
    cliCode: Schema.Option(PATPairingPublicCode),
  },
  OAuthReview: {
    requestId: Schema.String,
  },
  Connections: {
    attempt: Schema.Option(ConnectionAttemptReference),
  },
  Upgrade: {},
  AppIndex: {},
  Dashboard: {},
  Transactions: {},
  Recurring: {
    id: RecurringDigestReportParams.fields.id,
  },
  PATs: {},
  Agents: {
    after: Schema.Option(OAuthConnectionId),
  },
  Email: {},
  Recovery: {},
  NotFound: {
    path: Schema.String,
  },
});
export type AppRoute = typeof AppRoute.Type;
const fixed = (path: string): Route.Biparser<{}> => {
  const [first, ...remaining] = path.split("/").filter(Boolean);
  return first === undefined
    ? Route.root
    : remaining.reduce(
        (parser, segment) => pipe(parser, Route.slash(Route.literal(segment))),
        Route.literal(first)
      );
};

const parser = Route.oneOf(
  pipe(Route.root, Route.mapTo(AppRoute.Home)),
  pipe(fixed("politica"), Route.mapTo(AppRoute.Privacy)),
  pipe(fixed("cookies"), Route.mapTo(AppRoute.Cookies)),
  pipe(fixed("terminos"), Route.mapTo(AppRoute.Terms)),
  pipe(
    fixed("funciones"),
    Route.slash(Route.schemaSegment("slug", AppRoute.Feature.fields.slug)),
    Route.mapTo(AppRoute.Feature)
  ),
  pipe(fixed("auth/pair"), Route.query(pairingQuery), Route.mapTo(AppRoute.Pair)),
  pipe(fixed("auth/google"), Route.query(providerQuery), Route.mapTo(AppRoute.Google)),
  pipe(fixed("auth/microsoft"), Route.query(providerQuery), Route.mapTo(AppRoute.Microsoft)),
  pipe(fixed("auth/google-return"), Route.mapTo(AppRoute.GoogleReturn)),
  pipe(fixed("auth/microsoft-return"), Route.mapTo(AppRoute.MicrosoftReturn)),
  pipe(
    fixed("connect/cli"),
    Route.query(
      Schema.Struct({
        cliCode: Schema.OptionFromOptionalKey(PATPairingPublicCode),
      })
    ),
    Route.mapTo(AppRoute.CLI)
  ),
  pipe(
    fixed("oauth/review"),
    Route.slash(Route.schemaSegment("requestId", Schema.String)),
    Route.mapTo(AppRoute.OAuthReview)
  ),
  pipe(
    fixed("connections/continue"),
    Route.query(
      Schema.Struct({
        attempt: Schema.OptionFromOptionalKey(ConnectionAttemptReference),
      }).pipe(Schema.catchDecoding(() => Effect.succeedSome({ attempt: Option.none() })))
    ),
    Route.mapTo(AppRoute.Connections)
  ),
  pipe(fixed("upgrade"), Route.mapTo(AppRoute.Upgrade)),
  pipe(fixed("app"), Route.mapTo(AppRoute.AppIndex)),
  pipe(fixed("app/dashboard"), Route.mapTo(AppRoute.Dashboard)),
  pipe(fixed("app/transactions"), Route.mapTo(AppRoute.Transactions)),
  pipe(
    fixed("insights/recurring"),
    Route.slash(Route.schemaSegment("id", RecurringDigestReportParams.fields.id)),
    Route.mapTo(AppRoute.Recurring)
  ),
  pipe(fixed("settings/pats"), Route.mapTo(AppRoute.PATs)),
  pipe(
    fixed("settings/agents"),
    Route.query(
      Schema.Struct({
        after: Schema.OptionFromOptionalKey(OAuthConnectionId),
      })
    ),
    Route.mapTo(AppRoute.Agents)
  ),
  pipe(fixed("settings/email"), Route.mapTo(AppRoute.Email)),
  pipe(fixed("settings/recovery"), Route.mapTo(AppRoute.Recovery))
);
/** Decodes only canonical public references; unrecognized query keys never enter application state. */
export const parseAppRoute: (url: Url) => AppRoute = Route.parseUrlWithFallback(
  parser,
  AppRoute.NotFound
);
export const isSignedRoute = (route: AppRoute): boolean =>
  [
    "AppIndex",
    "Dashboard",
    "Transactions",
    "Recurring",
    "PATs",
    "Agents",
    "Email",
    "Recovery",
  ].includes(route._tag);
/** Selects a public page without retaining query strings or fragments in its feature model. */
export const publicPage = (route: AppRoute): Option.Option<string> =>
  Match.value(route).pipe(
    Match.tag("Home", () => Option.some("/")),
    Match.tag("Privacy", () => Option.some("/politica")),
    Match.tag("Cookies", () => Option.some("/cookies")),
    Match.tag("Terms", () => Option.some("/terminos")),
    Match.tag("Feature", (route) => Option.some(`/funciones/${route.slug}`)),
    Match.tag("NotFound", (route) => Option.some(route.path)),
    Match.orElse(() => Option.none())
  );
