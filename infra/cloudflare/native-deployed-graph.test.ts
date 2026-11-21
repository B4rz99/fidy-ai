import { ConfigProvider, Effect, Logger, Result, type Schema } from "effect";
import { expect, it } from "vitest";
import {
  NativeInventoryRefused,
  inspectNativeResources,
  requireDeployedRole,
  verifyDeployedVersion,
  verifySuccessorVersion,
  verifySuccessorVersionAt,
} from "./native-deployed-graph";
import { inspectNativeAccess } from "./native-deployed-access";
import { RecoveryPinUnavailable } from "./native-recovery-identity";
import { nativeBindingInventory } from "./native-graph";

const revision = "1".repeat(40),
  apiHost = "storage-acceptance.fidyapp.com",
  core = "fidy-native-storage-core",
  smoke = "fidy-native-smoke-" + revision;

const basic = { success: true, result: [] };

const queueNames = [
  "async-dead-letters",
  "forwarded-email",
  "connection-synchronization",
  "statement-extraction",
  "operational-canary",
  "billing-collection",
  "hosted-whatsapp",
  "weekly-delivery",
  "browser-pairing-email",
  "smoke-" + revision,
];

const buckets = [
  "statement-staging",
  "approved-ingest-samples",
  "forwarded-email",
  "release-smoke",
];

const workflows = [
  ["connection", "ConnectionSynchronizationWorkflow"],
  ["statement", "StatementExtractionWorkflowV1"],
  ["canary", "OperationalCanaryWorkflowV1"],
  ["billing", "BillingCollectionWorkflowV1"],
  ["refund", "BillingRefundWorkflowV1"],
  ["proactivity", "ProactivityDeliveryWorkflow"],
  ["login-email", "BrowserPairingEmailWorkflowV1"],
  ["smoke-" + revision, "ReleaseSmokeWorkflowV2"],
] as const;

const consumers = (url: URL): Schema.Json => {
  const [, , id] = url.pathname.split("/");

  if (id === "async-dead-letters") return basic;

  if (id === undefined || !queueNames.includes(id)) throw Error("Unexpected list " + url.pathname);

  return {
    ...basic,
    result: [
      {
        consumer_id: id,
        script: id.startsWith("smoke-") ? smoke : core,
        dead_letter_queue: "fidy-native-async-dead-letters",
        type: "worker",
        settings: {
          batch_size: id === "operational-canary" || id.startsWith("smoke-") ? 1 : 10,
          max_retries: 3,
          max_wait_time_ms: 0,
        },
      },
    ],
  };
};

const installed = (path: string): Schema.Json => {
  const url = new URL(path, "https://provider.invalid");

  if (url.pathname === "/r2/buckets") {
    return {
      ...basic,
      result: { buckets: buckets.map((slug) => ({ name: "fidy-native-" + slug })) },
      result_info: {},
    };
  }

  if (url.pathname === "/queues") {
    return {
      ...basic,
      result: queueNames.map((slug) => ({ queue_id: slug, queue_name: "fidy-native-" + slug })),
    };
  }

  if (url.pathname === "/workflows") {
    return {
      ...basic,
      result: workflows.map(([slug, cls]) => ({
        id: slug,
        name: "fidy-native-" + slug,
        class_name: cls,
        script_name: slug.startsWith("smoke-") ? smoke : core,
      })),
    };
  }

  return consumers(url);
};

it("requires all four buckets, eight exact Workflow owners and nine consumers with the untouched dead-letter queue", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const read = (path: string): Effect.Effect<unknown, Error> =>
        Effect.try(() => installed(path));

      const full = yield* inspectNativeResources(read, revision, true);
      expect(full.workflows).toHaveLength(8);
      expect(full.queues.flatMap((row) => row.consumers)).toHaveLength(9);
      expect(full.buckets).toHaveLength(4);
      expect(
        Result.isFailure(yield* Effect.result(inspectNativeResources(read, revision, false)))
      ).toBe(true);

      yield* Effect.forEach(
        [{ script: "incumbent" }, { script: core, script_name: "incumbent" }],
        Effect.fnUntraced(function* (conflicting) {
          const drift = (path: string): Effect.Effect<unknown, Error> =>
            path.includes("/billing-collection/consumers")
              ? Effect.succeed({
                  ...basic,
                  result: [
                    {
                      consumer_id: "billing-collection",
                      type: "worker",
                      dead_letter_queue: "fidy-native-async-dead-letters",
                      settings: { batch_size: 10, max_retries: 3, max_wait_time_ms: 0 },
                      ...conflicting,
                    },
                  ],
                })
              : read(path);

          expect(
            Result.isFailure(yield* Effect.result(inspectNativeResources(drift, revision, true)))
          ).toBe(true);
        }),
        { discard: true }
      );

      const foreign = (path: string): Effect.Effect<unknown, Error> =>
        path.includes("/async-dead-letters/consumers")
          ? Effect.succeed({ ...basic, result: [{ consumer_id: "other" }] })
          : read(path);

      expect(
        Result.isFailure(yield* Effect.result(inspectNativeResources(foreign, revision, true)))
      ).toBe(true);
    })
  ));

it("attributes an inventory read failure without disclosing provider messages", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const read = (path: string): Effect.Effect<unknown, Error> =>
        path.startsWith("workflows?")
          ? Effect.fail(Error("private-provider-message"))
          : Effect.try(() => installed(path));

      const failure = yield* Effect.flip(inspectNativeResources(read, revision, true));
      expect(failure).toBeInstanceOf(NativeInventoryRefused);
      expect(failure).toMatchObject({ phase: "Workflow list" });
      expect(failure.message).not.toContain("private-provider-message");
    })
  ));

type DeployedBinding =
  | Readonly<{ name: string; type: string; service: string; text: string }>
  | Readonly<{ name: string; type: string; text: string }>;

const deployedBinding = (name: string, type: string): DeployedBinding =>
  type === "service"
    ? {
        name,
        type,
        service: name === "CORE" ? core : smoke,
        text: name === "RECOVERY_ISOLATION" ? "isolated" : "closed",
      }
    : { name, type, text: name === "RECOVERY_ISOLATION" ? "isolated" : "closed" };

it("refuses a correct binding label connected to an incumbent or a foreign Worker", () => {
  const bindings = Object.fromEntries(
    [...nativeBindingInventory({ fingerprint: "", role: "Ingress" })].map(([name, type]) => [
      name,
      deployedBinding(name, type),
    ])
  );

  expect(() =>
    requireDeployedRole({ fingerprint: "", role: "Ingress", revision, bindings })
  ).not.toThrow();

  for (const name of ["CORE", "RELEASE_FIXTURE"]) {
    expect(() =>
      requireDeployedRole({
        fingerprint: "",
        role: "Ingress",
        revision,
        bindings: { ...bindings, [name]: { ...bindings[name], service: "incumbent" } },
      })
    ).toThrow();
  }
});

it("verifies the exact serving assets-only version independently of executable Worker bindings", () => {
  const versionId = "2c096680-5f52-472f-afdd-5b3475b9418f";

  const assets = {
    html_handling: "none",
    not_found_handling: "single-page-application",
    base_path: "/",
    serve_directly: true,
    raw_run_worker_first: false,
  };

  const staticResources = {
    bindings: [],
    script: { handlers: null },
    script_runtime: { assets, compatibility_date: "2026-09-08" },
  };

  const check = (resources: unknown, id = versionId, role: "Web" | "Ingress" = "Web"): void =>
    verifyDeployedVersion({
      fingerprint: "",
      raw: { success: true, result: { id, resources } },
      versionId,
      revision,
      role,
      account: "fixture-account",
    });

  expect(() => check(staticResources)).not.toThrow();
  expect(() => check(staticResources, "another-version")).toThrow();
  expect(() => check(staticResources, versionId, "Ingress")).toThrow();

  for (const extra of [
    { bindings: [{ type: "service", name: "CORE" }] },
    { script: { handlers: ["fetch"] } },
    { script: { handlers: null, named_handlers: [{ name: "extra", handlers: ["class"] }] } },
    { script_runtime: {} },
    { script_runtime: { assets: { ...assets, raw_run_worker_first: true } } },
    { script_runtime: { assets: { ...assets, serve_directly: false } } },
    { script_runtime: { assets: { ...assets, base_path: "/other" } } },
    { script_runtime: { assets: { ...assets, not_found_handling: "404-page" } } },
  ]) {
    expect(() => check({ ...staticResources, ...extra })).toThrow();
  }
});

it("requires all five pinned Alchemy runtime bindings alongside only the declared executable bindings", () => {
  const versionId = "9635b92e-fcc9-41b6-a7e2-4fd97c9eddd9";
  const account = "a".repeat(32);

  const entries = {
    RELEASE_GIT_SHA: revision,
    ALCHEMY_PHASE: "runtime",
    ALCHEMY_STACK_NAME: "FidyNativeStorage",
    ALCHEMY_STAGE: "production",
    ALCHEMY_WORKER_NAME: "fidy-native-email",
    ALCHEMY_CLOUDFLARE_ACCOUNT_ID: account,
  };

  const check = (values: Record<string, string>): void => {
    const bindings = Object.entries(values).map(([name, text]) => ({
      name,
      type: "plain_text",
      text,
    }));

    const raw = {
      success: true,
      result: {
        id: versionId,
        resources: {
          bindings,
          script: { handlers: ["email"], named_handlers: [] },
          script_runtime: { compatibility_date: "2026-09-08" },
        },
      },
    };

    verifyDeployedVersion({
      fingerprint: "",
      raw,
      versionId,
      revision,
      account,
      role: "ForwardedEmail",
    });
  };

  expect(() => check(entries)).not.toThrow();

  for (const name of Object.keys(entries)) {
    expect(() => check({ ...entries, [name]: "another-value" })).toThrow();
  }

  expect(() => check({ ...entries, ALCHEMY_UNREVIEWED: "runtime" })).toThrow();
});

it("uses the selected Smoke generation without relaxing the immutable source or version checks", () => {
  const account = "a".repeat(32);
  const versionId = "9635b92e-fcc9-41b6-a7e2-4fd97c9eddd9";
  const source = "2".repeat(40);

  const text = {
    ALCHEMY_PHASE: "runtime",
    ALCHEMY_WORKER_NAME: smoke,
    ALCHEMY_STACK_NAME: "FidyNativeStorage",
    ALCHEMY_STAGE: "production",
    ALCHEMY_CLOUDFLARE_ACCOUNT_ID: account,
    RELEASE_GIT_SHA: source,
    SMOKE_QUEUE_NAME: smoke,
    CONTRACT_DIGEST: "3".repeat(64),
    NATIVE_STORAGE_ADMISSION: "closed",
    ACCEPTANCE_API_ORIGIN: "https://" + apiHost,
  };

  const version = {
    success: true,
    result: {
      id: versionId,
      resources: {
        bindings: [
          ...Object.entries(text).map(([name, text]) => ({ name, text, type: "plain_text" })),
          { name: "SMOKE_BUCKET", type: "r2_bucket", bucket_name: "fidy-native-release-smoke" },
          {
            name: "SMOKE_WORKFLOW",
            type: "workflow",
            workflow_name: smoke,
            class_name: "ReleaseSmokeWorkflowV2",
          },
          { name: "CF_VERSION_METADATA", type: "version_metadata" },
          { name: "ACCEPTANCE_CODE_KEY", type: "secret_text" },
          { name: "ACCEPTANCE_GOOGLE_SECRET", type: "secret_text" },
          { name: "ACCEPTANCE_MICROSOFT_SECRET", type: "secret_text" },
        ],
        script: { handlers: ["fetch", "queue"], named_handlers: [] },
        script_runtime: { compatibility_date: "2026-09-08" },
      },
    },
  };

  const input = {
    account,
    raw: version,
    revision: source,
    versionId,
    role: "Smoke",
    fingerprint: "4".repeat(64),
  } as const;

  const historical = { ...input, generation: revision };
  expect(() => verifySuccessorVersionAt(historical)).not.toThrow();
  expect(() => verifySuccessorVersion(input)).toThrow();
  expect(() => verifySuccessorVersionAt({ ...historical, revision })).toThrow();
  expect(() => verifySuccessorVersionAt({ ...historical, versionId: "other" })).toThrow();
});

const appRoles = [
  ["Fidy native support recovery", "/internal/support-recovery", "CLOUDFLARE_ACCESS_AUDIENCE"],
  ["Fidy native Titular erasure", "/internal/titular-erasure", "ERASURE_SUPPORT_AUDIENCE"],
  ["Fidy native beta Pro operator", "/internal/beta-pro", "BETA_PRO_AUDIENCE"],
  ["Fidy native IngestSample review", "/internal/sample-review", "SAMPLE_REVIEW_AUDIENCE"],
] as const;

const human = "obarboza@fidyapp.com",
  operator = "release@example.test";

const pin = "cce95413-ef9d-4483-89ab-8a50a7e6cafa";

const loginMethods = [
  { id: pin, name: "Existing account email PIN", type: "onetimepin" },
  { id: "4c744781-b096-4712-a549-de0397a916a6", name: "", type: "cloudflare" },
];

const applications = appRoles.map(([name, path, binding]) => ({
  id: binding,
  name,
  aud: binding,
  type: "self_hosted",
  destinations: [{ type: "public", uri: apiHost + path }],
  allowed_idps: [pin],
  session_duration: "15m",
  app_launcher_visible: false,
}));

const bindings = {
  ...Object.fromEntries(appRoles.map(([, , key]) => [key, { type: "plain_text", text: key }])),
  BETA_PRO_OPERATOR_EMAIL: { type: "plain_text", text: human },
};

const accessReply = (path: string): Schema.Json => {
  if (path.startsWith("account/access/apps?") || path.startsWith("zone/access/apps?")) {
    return { ...basic, result: applications };
  }

  if (path.startsWith("account/access/identity_providers")) {
    return {
      ...basic,
      result: loginMethods,
    };
  }

  if (path.startsWith("account/access/groups")) {
    return {
      ...basic,
      result: [
        {
          id: "recovery-group",
          name: "Fidy native recovery operators",
          include: [{ email: { email: operator } }],
        },
      ],
    };
  }

  const selector: Schema.JsonObject = path.includes("/CLOUDFLARE_ACCESS_AUDIENCE/")
    ? { group: { id: "recovery-group" } }
    : { email: { email: human } };

  return {
    ...basic,
    result: [{ decision: "allow", precedence: 1, session_duration: "15m", include: [selector] }],
  };
};

const verify = (
  source: (path: string) => Schema.Json,
  installed = true,
  options = { canonicalDiagnostics: false }
): ReturnType<typeof inspectNativeAccess> =>
  inspectNativeAccess({
    account: "account/",
    zone: "zone/",
    hosts: [apiHost, "storage-web-acceptance.fidyapp.com"].concat(
      options.canonicalDiagnostics ? ["api.fidyapp.com"] : []
    ),
    apiHosts: [apiHost],
    staging: false,
    ...options,
    workers: [core],
    installed,
    bindings,
    read: (path) => Effect.try(() => source(path)),
  }).pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({
        RECOVERY_OPERATOR_EMAIL: operator,
        SAMPLE_REVIEWER_EMAIL: human,
        BETA_PRO_OPERATOR_EMAIL: human,
      })
    )
  );

const fresh =
  (result: Schema.JsonArray): ((path: string) => Schema.Json) =>
  (path) =>
    path.startsWith("account/access/identity_providers") ? { ...basic, result } : basic;

it("requires exactly one account OTP before first install regardless of its display name", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      expect(yield* verify(fresh(loginMethods), false)).toEqual([]);

      yield* Effect.forEach(
        [
          [[], "missing"],
          [
            [{ id: pin, name: "Fidy native recovery email PIN", type: "oidc" }],
            "name matches another type",
          ],
          [
            [
              ...loginMethods,
              {
                id: "4fa581d3-75e5-4545-93b5-4e7b9d120f68",
                name: "another PIN",
                type: "onetimepin",
              },
            ],
            "ambiguous",
          ],
          [[{ id: "", name: "Email PIN", type: "onetimepin" }], "invalid ID"],
        ] as const,
        Effect.fnUntraced(function* ([methods, reason]) {
          const refusal = yield* Effect.flip(verify(fresh(methods), false));
          expect(refusal).toBeInstanceOf(RecoveryPinUnavailable);
          expect(refusal).toMatchObject({ reason });
        }),
        { discard: true }
      );
    })
  ));

it("requires independent Access scopes, a distinct audience per role and the sole designated sample reviewer", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      expect(yield* verify(accessReply)).toHaveLength(4);
      expect(
        Result.isFailure(
          yield* Effect.result(
            verify((path) =>
              path.startsWith("account/access/identity_providers")
                ? {
                    ...basic,
                    result: [
                      {
                        id: "34150703-a00a-4bc1-b035-9d0901ff9b60",
                        name: "Replaced",
                        type: "onetimepin",
                      },
                    ],
                  }
                : accessReply(path)
            )
          )
        )
      ).toBe(true);

      yield* Effect.forEach(
        [
          "zone/access/apps",
          "account/access/apps/SAMPLE_REVIEW_AUDIENCE/policies",
          "account/access/apps/BETA_PRO_AUDIENCE/policies",
        ],
        Effect.fnUntraced(function* (target) {
          expect(
            Result.isFailure(
              yield* Effect.result(
                verify((path) =>
                  path.startsWith(target)
                    ? {
                        ...basic,
                        result: [
                          {
                            ...applications[0],
                            id: "shadow",
                            name: "shadow",
                            destinations: [{ type: "all_workers" }],
                          },
                        ],
                      }
                    : accessReply(path)
                )
              )
            )
          ).toBe(true);
        }),
        { discard: true }
      );

      expect(
        Result.isFailure(
          yield* Effect.result(
            verify((path) => {
              if (path.startsWith("zone/")) throw Error("unreadable");

              return accessReply(path);
            })
          )
        )
      ).toBe(true);
    })
  ));

it("reports a fixed canonical Access reason and allowlisted path projection", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const reports: unknown[] = [];

      const loggers = new Set([
        Logger.make<unknown, void>(({ message }) => {
          reports.push(message);
        }),
      ]);

      const unexpectedId = "bcaee459-9687-423e-958d-c25b38ca8013";
      const privateText = "no-log@example.test";

      const unexpected = {
        id: unexpectedId,
        name: privateText,
        aud: privateText,
        type: "self_hosted",
        destinations: [
          { type: "public", uri: apiHost + "/internal/support-recovery" },
          { type: "public", uri: apiHost + "/" + privateText },
        ],
      };

      const unrelatedId = "bccee459-9687-423e-958d-c25b38ca8013";

      const source = (path: string): Schema.Json =>
        path.startsWith("zone/access/apps?")
          ? {
              ...basic,
              result: [
                ...applications,
                unexpected,
                { ...unexpected, id: unrelatedId, destinations: [] },
              ],
            }
          : accessReply(path);

      const checked = yield* verify(source, true, {
        canonicalDiagnostics: true,
      }).pipe(Effect.result, Effect.provideService(Logger.CurrentLoggers, loggers));

      expect(Result.isFailure(checked)).toBe(true);
      const text = reports.join("\n");
      expect(text).toContain("selected application count");
      expect(text).toContain(unexpectedId);
      expect(text).toContain(apiHost + "/internal/support-recovery");
      expect(text).toContain(apiHost + " other");
      expect(text).toContain('"expectedNativeRole":false');
      expect(text).toContain('"unlistedPathCount":1');
      expect(text).not.toContain(privateText);
      expect(text).not.toContain(unrelatedId);
      expect(text).not.toContain(operator);

      reports.length = 0;

      const withoutDiagnostics = yield* verify(source).pipe(
        Effect.result,
        Effect.provideService(Logger.CurrentLoggers, loggers)
      );

      expect(Result.isFailure(withoutDiagnostics)).toBe(true);
      expect(reports).toEqual([]);
    })
  ));
