import { ConfigProvider, Effect, Result } from "effect";
import { expect, it } from "vitest";
import { inspectNativeResources, requireDeployedRole } from "./native-deployed-graph";
import { inspectNativeAccess } from "./native-deployed-access";
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
const consumers = (url: URL): unknown => {
  const [, , id] = url.pathname.split("/");
  if (id === "async-dead-letters") return basic;
  if (id === undefined || !queueNames.includes(id)) throw Error("Unexpected list " + url.pathname);
  return {
    ...basic,
    result: [
      {
        consumer_id: id,
        script_name: id.startsWith("smoke-") ? smoke : core,
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
const installed = (path: string): unknown => {
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
      const foreign = (path: string): Effect.Effect<unknown, Error> =>
        path.includes("/async-dead-letters/consumers")
          ? Effect.succeed({ ...basic, result: [{ consumer_id: "other" }] })
          : read(path);
      expect(
        Result.isFailure(yield* Effect.result(inspectNativeResources(foreign, revision, true)))
      ).toBe(true);
    })
  ));
it("refuses a correct binding label connected to an incumbent or a foreign Worker", () => {
  const bindings = Object.fromEntries(
    [...nativeBindingInventory("Ingress")].map(([name, type]) => [
      name,
      {
        name,
        type,
        ...(type === "service" ? { service: name === "CORE" ? core : smoke } : {}),
        text: name === "RECOVERY_ISOLATION" ? "isolated" : "closed",
      },
    ])
  );
  expect(() => requireDeployedRole({ role: "Ingress", revision, bindings })).not.toThrow();
  for (const name of ["CORE", "RELEASE_FIXTURE"]) {
    expect(() =>
      requireDeployedRole({
        role: "Ingress",
        revision,
        bindings: { ...bindings, [name]: { ...bindings[name], service: "incumbent" } },
      })
    ).toThrow();
  }
});
const appRoles = [
  ["Fidy native support recovery", "/internal/support-recovery", "CLOUDFLARE_ACCESS_AUDIENCE"],
  ["Fidy native Titular erasure", "/internal/titular-erasure", "ERASURE_SUPPORT_AUDIENCE"],
  ["Fidy native beta Pro operator", "/internal/beta-pro", "BETA_PRO_AUDIENCE"],
  ["Fidy native IngestSample review", "/internal/sample-review", "SAMPLE_REVIEW_AUDIENCE"],
] as const;
const human = "obarboza@fidyapp.com",
  operator = "release@example.test";
const applications = appRoles.map(([name, path, binding]) => ({
  id: binding,
  name,
  aud: binding,
  type: "self_hosted",
  destinations: [{ type: "public", uri: apiHost + path }],
  allowed_idps: ["pin"],
  session_duration: "15m",
  app_launcher_visible: false,
}));
const bindings = {
  ...Object.fromEntries(appRoles.map(([, , key]) => [key, { type: "plain_text", text: key }])),
  BETA_PRO_OPERATOR_EMAIL: { type: "plain_text", text: human },
};
const accessReply = (path: string): unknown => {
  if (path.startsWith("account/access/apps?") || path.startsWith("zone/access/apps?")) {
    return { ...basic, result: applications };
  }
  if (path.startsWith("account/access/identity_providers")) {
    return {
      ...basic,
      result: [{ id: "pin", name: "Fidy native recovery email PIN", type: "onetimepin" }],
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
  const selector = path.includes("/CLOUDFLARE_ACCESS_AUDIENCE/")
    ? { group: { id: "recovery-group" } }
    : { email: { email: human } };
  return {
    ...basic,
    result: [{ decision: "allow", precedence: 1, session_duration: "15m", include: [selector] }],
  };
};
it("requires independent Access scopes, a distinct audience per role and the sole designated sample reviewer", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const verify = (source: (path: string) => unknown): ReturnType<typeof inspectNativeAccess> =>
        inspectNativeAccess({
          account: "account/",
          zone: "zone/",
          hosts: [apiHost, "storage-web-acceptance.fidyapp.com"],
          apiHosts: [apiHost],
          staging: false,
          workers: [core],
          installed: true,
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
      expect(yield* verify(accessReply)).toHaveLength(4);
      for (const target of [
        "zone/access/apps",
        "account/access/apps/SAMPLE_REVIEW_AUDIENCE/policies",
        "account/access/apps/BETA_PRO_AUDIENCE/policies",
      ]) {
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
      }
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
