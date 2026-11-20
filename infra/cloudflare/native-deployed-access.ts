import { isDeepStrictEqual } from "node:util";
import { Config, Effect, Schema } from "effect";
import { readRecoveryPin } from "./native-recovery-identity";

import { type ProviderRead as Read, readProviderList as readNamed } from "./native-provider-list";

const name = Schema.NonEmptyString;
const optionalStrings = Schema.optional(Schema.Array(name));
const App = Schema.Struct({
  id: name,
  name: Schema.optional(Schema.String),
  type: Schema.String,
  domain: Schema.optional(Schema.String),
  self_hosted_domains: optionalStrings,
  destinations: Schema.optional(
    Schema.Array(
      Schema.Struct({
        type: name,
        uri: Schema.optional(Schema.String),
        worker_id: Schema.optional(Schema.String),
        overrides: Schema.optional(Schema.Tuple([])),
      })
    )
  ),
  aud: Schema.optional(Schema.String),
  session_duration: Schema.optional(Schema.String),
  allowed_idps: optionalStrings,
  app_launcher_visible: Schema.optional(Schema.Boolean),
  options_preflight_bypass: Schema.optional(Schema.Boolean),
  allow_authenticate_via_warp: Schema.optional(Schema.Boolean),
});
const subjects = [
  {
    name: "Fidy native beta Pro operator",
    path: "/internal/beta-pro",
    binding: "BETA_PRO_AUDIENCE",
  },
  {
    name: "Fidy native support recovery",
    path: "/internal/support-recovery",
    binding: "CLOUDFLARE_ACCESS_AUDIENCE",
  },
  {
    name: "Fidy native Titular erasure",
    path: "/internal/titular-erasure",
    binding: "ERASURE_SUPPORT_AUDIENCE",
  },
  {
    name: "Fidy native IngestSample review",
    path: "/internal/sample-review",
    binding: "SAMPLE_REVIEW_AUDIENCE",
  },
] as const;
const findUris = (app: typeof App.Type): ReadonlyArray<string> => [
  ...new Set(
    [
      app.domain ?? "",
      ...(app.self_hosted_domains ?? []),
      ...(app.destinations ?? []).map((item) => item.uri ?? ""),
    ].filter(Boolean)
  ),
];
const addressesHost = (uri: string, hosts: readonly string[]): boolean => {
  const host = uri.replace(/^https?:\/\//u, "").split("/")[0] ?? "";
  return hosts.some((accepted) => new Bun.Glob(host).match(accepted));
};
const related = (app: typeof App.Type, input: Input): boolean =>
  subjects.some((item) => item.name === app.name) ||
  findUris(app).some((uri) => addressesHost(uri, input.hosts)) ||
  (app.destinations ?? []).some(
    (destination) =>
      ["all_workers", "all_preview_workers"].includes(destination.type) ||
      input.workers.includes(destination.worker_id ?? "")
  );
const fifteenMinutes = (value?: string): boolean =>
  ["15m", "15m0s", "900s", "0h15m0s"].includes(value ?? "");
const selectors = Schema.Struct({
  include: Schema.Array(Schema.Unknown),
  exclude: Schema.optional(Schema.Array(Schema.Unknown)),
  require: Schema.optional(Schema.Array(Schema.Unknown)),
});
const matchesSelector = (row: typeof selectors.Type, wanted: unknown): boolean =>
  isDeepStrictEqual(row.include, [wanted]) &&
  (row.exclude ?? []).length === 0 &&
  (row.require ?? []).length === 0;
const validatePolicy = Effect.fn(function* (read: Read, path: string, selector: unknown) {
  const policy = Schema.Struct({
    ...selectors.fields,
    decision: Schema.Literal("allow"),
    precedence: Schema.Literal(1),
    session_duration: name,
  });
  const body = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ success: Schema.Literal(true), result: Schema.Tuple([policy]) })
  )(yield* read(path + "?per_page=100"));
  const row = body.result[0];
  if (!matchesSelector(row, selector) || !fifteenMinutes(row.session_duration)) {
    return yield* Effect.fail(Error("Unapproved Access policy membership or duration"));
  }
});
const restricted = (app: typeof App.Type): boolean =>
  app.app_launcher_visible === false &&
  app.options_preflight_bypass !== true &&
  app.allow_authenticate_via_warp !== true;
const appShape = (
  app: typeof App.Type,
  coordinates: ReadonlyArray<string>,
  idp: string
): boolean => {
  const present = findUris(app);
  const destinations = app.destinations ?? [];
  return (
    app.type === "self_hosted" &&
    isDeepStrictEqual(present.toSorted(), coordinates.toSorted()) &&
    destinations.every((item) => item.type === "public") &&
    isDeepStrictEqual(app.allowed_idps, [idp]) &&
    fifteenMinutes(app.session_duration) &&
    restricted(app)
  );
};
type Input = {
  read: Read;
  account: string;
  zone: string;
  installed: boolean;
  hosts: readonly string[];
  apiHosts: readonly string[];
  staging: boolean;
  workers: readonly string[];
  bindings: Readonly<Record<string, unknown>>;
};
const configuredRole = Effect.fn(function* (
  input: Input,
  selection: { app: typeof App.Type; role: (typeof subjects)[number] },
  identities: { idp: string; group: string; reviewer: string; betaOperator: string }
) {
  const { app, role } = selection;
  const approved = input.apiHosts.map((host) => host + role.path);
  const audience = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ type: Schema.Literal("plain_text"), text: name })
  )(input.bindings[role.binding]);
  const paths =
    input.staging === true && appShape(app, approved.slice(0, 1), identities.idp)
      ? approved.slice(0, 1)
      : approved;
  if (app.aud !== audience.text || !appShape(app, paths, identities.idp)) {
    return yield* Effect.fail(Error("Unexpected Access application for " + role.name));
  }
  const email = {
    SAMPLE_REVIEW_AUDIENCE: identities.reviewer,
    BETA_PRO_AUDIENCE: identities.betaOperator,
    ERASURE_SUPPORT_AUDIENCE: "obarboza@fidyapp.com",
    CLOUDFLARE_ACCESS_AUDIENCE: null,
  }[role.binding];
  const selector = email === null ? { group: { id: identities.group } } : { email: { email } };
  yield* validatePolicy(
    input.read,
    input.account + "access/apps/" + app.id + "/policies",
    selector
  );
  return {
    name: role.name,
    appId: app.id,
    paths,
    membership: email ?? role.binding,
  };
});
const relevantApplications = Effect.fn(function* (input: Input) {
  const { read, account, zone } = input;
  const appScopes = yield* Effect.forEach([account, zone], (scope) =>
    readNamed(read, scope + "access/apps", App)
  );
  const active = new Map<string, typeof App.Type>();
  for (const rows of appScopes) {
    for (const app of rows.filter((item) => related(item, input))) {
      const previous = active.get(app.id);
      if (previous !== undefined && !isDeepStrictEqual(previous, app)) {
        return yield* Effect.fail(Error("Account and zone disagree on protected Access"));
      }
      active.set(app.id, app);
    }
  }
  return active;
});

export const inspectNativeAccess = Effect.fn(function* (input: Input) {
  const { read, account, installed } = input;
  const active = yield* relevantApplications(input);
  const idp = yield* readRecoveryPin(read, account);
  const groups = (yield* readNamed(
    read,
    account + "access/groups",
    Schema.Struct({ ...selectors.fields, id: name, name })
  )).filter((row) => row.name === "Fidy native recovery operators");
  if (!installed) {
    if (active.size + groups.length !== 0) {
      return yield* Effect.fail(Error("Protected Access target already exists"));
    }
    return [];
  }
  const [group] = yield* Schema.decodeUnknownEffect(
    Schema.Tuple([Schema.Struct({ ...selectors.fields, id: name })])
  )(groups);
  const email = yield* Config.String("RECOVERY_OPERATOR_EMAIL"),
    reviewer = yield* Config.Literal("obarboza@fidyapp.com", "SAMPLE_REVIEWER_EMAIL");
  const betaOperator = yield* Config.Literal("obarboza@fidyapp.com", "BETA_PRO_OPERATOR_EMAIL");
  yield* Schema.decodeUnknownEffect(
    Schema.Struct({ type: Schema.Literal("plain_text"), text: Schema.Literal(betaOperator) })
  )(input.bindings.BETA_PRO_OPERATOR_EMAIL);
  if (active.size !== subjects.length || !matchesSelector(group, { email: { email } })) {
    return yield* Effect.fail(Error("Unexpected native Access authority inventory"));
  }
  const rows = [...active.values()];
  if (new Set(rows.map((row) => row.aud)).size !== subjects.length) {
    return yield* Effect.fail(Error("Access audiences must be distinct"));
  }
  return yield* Effect.forEach(
    subjects,
    Effect.fn(function* (role) {
      const app = rows.find((row) => row.name === role.name);
      if (app === undefined) {
        return yield* Effect.fail(Error("Missing protected application " + role.name));
      }
      return yield* configuredRole(
        input,
        { app, role },
        { idp, group: group.id, reviewer, betaOperator }
      );
    })
  );
});
