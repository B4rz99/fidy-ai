import type { WorkerBindings } from "./rollback-compatibility";
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

const validatePolicy = Effect.fn(function* (input: Input, path: string, selector: unknown) {
  const policy = Schema.Struct({
    ...selectors.fields,
    decision: Schema.Literal("allow"),
    precedence: Schema.Literal(1),
    session_duration: name,
  });

  const body = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ success: Schema.Literal(true), result: Schema.Tuple([policy]) })
  )(yield* input.read(path + "?per_page=100").pipe(accessStep(input, "policy read"))).pipe(
    accessStep(input, "policy count, decision and precedence")
  );

  const row = body.result[0];

  if (!matchesSelector(row, selector) || !fifteenMinutes(row.session_duration)) {
    return yield* accessRefusal(input, "policy selector or session duration");
  }
});

const restricted = (app: typeof App.Type): boolean =>
  app.app_launcher_visible === false &&
  app.options_preflight_bypass !== true &&
  app.allow_authenticate_via_warp !== true;

const applicationChecks = (
  app: typeof App.Type,
  coordinates: ReadonlyArray<string>,
  { idp, audience }: { idp: string; audience: string }
): ReadonlyArray<readonly [string, boolean]> =>
  [
    ["role audience", app.aud === audience],
    [
      "application type or destinations",
      app.type === "self_hosted" &&
        (app.destinations ?? []).every((item) => item.type === "public"),
    ],
    ["application paths", isDeepStrictEqual(findUris(app).toSorted(), coordinates.toSorted())],
    ["application identity provider", isDeepStrictEqual(app.allowed_idps, [idp])],
    [
      "application session duration or controls",
      fifteenMinutes(app.session_duration) && restricted(app),
    ],
  ] as const;

type Input = {
  read: Read;
  account: string;
  zone: string;
  installed: boolean;
  hosts: readonly string[];
  apiHosts: readonly string[];
  staging: boolean;
  canonicalDiagnostics: boolean;
  workers: readonly string[];
  bindings: WorkerBindings;
};

const accessStep =
  (input: Pick<Input, "canonicalDiagnostics">, reason: string) =>
  <A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    work.pipe(
      Effect.tapCause(() =>
        input.canonicalDiagnostics
          ? Effect.logError("Canonical Access verification failed at " + reason)
          : Effect.void
      )
    );

const accessRefusal = (
  input: Pick<Input, "canonicalDiagnostics">,
  reason: string
): Effect.Effect<never, Error> =>
  Effect.fail(Error("Protected Access verification failed at " + reason)).pipe(
    accessStep(input, reason)
  );

type RelevantScope = Readonly<{
  scope: "account" | "zone";
  rows: readonly (typeof App.Type)[];
}>;

type AccessRead = Pick<Input, "read" | "account" | "zone">;

const readApplicationInventory = Effect.fn(function* (
  input: AccessRead & Pick<Input, "canonicalDiagnostics">
) {
  const { read, account, zone } = input;

  return yield* Effect.forEach(
    [
      { scope: "account", path: account },
      { scope: "zone", path: zone },
    ] as const,
    Effect.fn(function* ({ scope, path }) {
      const rows = yield* readNamed(read, path + "access/apps", App).pipe(
        accessStep(input, scope + " application inventory")
      );

      return { scope, rows };
    })
  );
});

const maxDiagnosticApplications = 24;

const accessIdPattern = /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/iu;

const encodeDiagnostic = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const routeCategories = ["login", "providers", "web", "internal"] as const;

const classifyRoute = (uri: string): string => {
  const path = uri.replace(/^https?:\/\//u, "").replace(/^[^/]+/u, "");

  if (path === "" || path === "/") return "root";

  if (path === "/*" || path === "/**") return "catch-all";

  return (
    routeCategories.find(
      (segment) => path === "/" + segment || path.startsWith("/" + segment + "/")
    ) ?? "other"
  );
};

const summarizeRoutes = (configured: readonly string[], hosts: readonly string[]): string[] =>
  [
    ...new Set(
      configured.flatMap((uri) =>
        hosts.flatMap((host) =>
          addressesHost(uri, [host]) ? [host + " " + classifyRoute(uri)] : []
        )
      )
    ),
  ].toSorted();

const applicationDiagnostic = (input: Input, scopes: readonly RelevantScope[]): string => {
  const approvedPaths = new Set(
    input.hosts.flatMap((host) =>
      ["", "/", ...subjects.map((role) => role.path)].map((path) => host + path)
    )
  );

  const relevant = scopes.flatMap(({ scope, rows }) => rows.map((app) => ({ scope, app })));

  const applications = relevant.slice(0, maxDiagnosticApplications).map(({ scope, app }) => {
    const configured = findUris(app);

    const paths = configured
      .map((path) => path.replace(/^https?:\/\//u, ""))
      .filter((path) => approvedPaths.has(path));

    return {
      scope,
      id: accessIdPattern.test(app.id) ? app.id : "invalid",
      expectedNativeRole: subjects.some((role) => role.name === app.name),
      paths,
      routeScopes: summarizeRoutes(configured, input.hosts),
      unlistedPathCount: configured.length - paths.length,
    };
  });

  return (
    "Canonical Access applications " +
    encodeDiagnostic({
      applications,
      omitted: relevant.length - applications.length,
    })
  );
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
  )(input.bindings[role.binding]).pipe(accessStep(input, "role audience binding"));

  const acceptance = approved.slice(0, 1);

  const paths =
    input.staging === true && isDeepStrictEqual(findUris(app).toSorted(), acceptance)
      ? acceptance
      : approved;

  const failure = applicationChecks(app, paths, {
    idp: identities.idp,
    audience: audience.text,
  }).find(([, valid]) => !valid);

  if (failure !== undefined) {
    return yield* accessRefusal(input, failure[0]);
  }

  const email = {
    SAMPLE_REVIEW_AUDIENCE: identities.reviewer,
    BETA_PRO_AUDIENCE: identities.betaOperator,
    ERASURE_SUPPORT_AUDIENCE: "obarboza@fidyapp.com",
    CLOUDFLARE_ACCESS_AUDIENCE: null,
  }[role.binding];

  const selector = email === null ? { group: { id: identities.group } } : { email: { email } };
  yield* validatePolicy(input, input.account + "access/apps/" + app.id + "/policies", selector);

  return {
    name: role.name,
    appId: app.id,
    paths,
    membership: email ?? role.binding,
  };
});

const relevantApplications = Effect.fn(function* (input: Input) {
  const inventory = yield* readApplicationInventory(input);

  const appScopes = inventory.map(({ scope, rows }) => ({
    scope,
    rows: rows.filter((app) => related(app, input)),
  }));

  if (input.canonicalDiagnostics) {
    yield* Effect.logInfo(applicationDiagnostic(input, appScopes));
  }

  const active = new Map<string, typeof App.Type>();

  for (const { rows } of appScopes) {
    for (const app of rows) {
      const previous = active.get(app.id);

      if (previous !== undefined && !isDeepStrictEqual(previous, app)) {
        return yield* accessRefusal(input, "account and zone application disagreement");
      }

      active.set(app.id, app);
    }
  }

  return active;
});

export const inspectNativeAccess = Effect.fn(function* (input: Input) {
  const { read, account, installed } = input;
  const active = yield* relevantApplications(input);

  const idp = yield* readRecoveryPin(read, account).pipe(
    accessStep(input, "recovery identity provider")
  );

  const groups = (yield* readNamed(
    read,
    account + "access/groups",
    Schema.Struct({ ...selectors.fields, id: name, name })
  ).pipe(accessStep(input, "recovery group inventory"))).filter(
    (row) => row.name === "Fidy native recovery operators"
  );

  if (!installed) {
    if (active.size + groups.length !== 0) {
      return yield* Effect.fail(Error("Protected Access target already exists"));
    }

    return [];
  }

  const [group] = yield* Schema.decodeUnknownEffect(
    Schema.Tuple([Schema.Struct({ ...selectors.fields, id: name })])
  )(groups).pipe(accessStep(input, "recovery group count"));

  const email = yield* Config.String("RECOVERY_OPERATOR_EMAIL"),
    reviewer = yield* Config.Literal("obarboza@fidyapp.com", "SAMPLE_REVIEWER_EMAIL");

  const betaOperator = yield* Config.Literal("obarboza@fidyapp.com", "BETA_PRO_OPERATOR_EMAIL");
  yield* Schema.decodeUnknownEffect(
    Schema.Struct({ type: Schema.Literal("plain_text"), text: Schema.Literal(betaOperator) })
  )(input.bindings.BETA_PRO_OPERATOR_EMAIL).pipe(accessStep(input, "operator binding"));

  if (active.size !== subjects.length) {
    return yield* accessRefusal(input, "selected application count");
  }

  if (!matchesSelector(group, { email: { email } })) {
    return yield* accessRefusal(input, "recovery group selector");
  }

  const rows = [...active.values()];

  if (new Set(rows.map((row) => row.aud)).size !== subjects.length) {
    return yield* accessRefusal(input, "duplicate role audience");
  }

  return yield* Effect.forEach(
    subjects,
    Effect.fn(function* (role) {
      const app = rows.find((row) => row.name === role.name);

      if (app === undefined) {
        return yield* accessRefusal(input, "missing native role");
      }

      return yield* configuredRole(
        input,
        { app, role },
        { idp, group: group.id, reviewer, betaOperator }
      );
    })
  );
});
