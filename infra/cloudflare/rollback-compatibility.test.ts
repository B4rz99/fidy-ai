import { describe, expect, it } from "vitest";
import {
  type WorkerBindings,
  type WorkerResources,
  rollbackCompatible,
  verifiedVersionResources,
} from "./rollback-compatibility";

const worker = (migrationTag: string, bindings: WorkerBindings): WorkerResources => ({
  runtime: {},
  migrationTag,
  bindings,
  exports: { Counter: { type: "durable-object", state: "created" } },
});

const base = {
  stable: worker("v1", { USER_STORE: { type: "durable_object_namespace" } }),
  candidate: worker("v1", { USER_STORE: { type: "durable_object_namespace" } }),
  workflowPaths: ["apps/server/cloudflare/subscription/runtime.ts"],
};

describe("rollback compatibility evidence", () => {
  it("accepts a code-only release with identical runtime resources", () => {
    expect(
      rollbackCompatible({ ...base, changedPaths: ["apps/server/cloudflare/core-worker.ts"] })
    ).toBe(true);
  });
  it("refuses schema and resource changes even when the old Worker version remains available", () => {
    expect(
      rollbackCompatible({
        ...base,
        changedPaths: ["apps/server/cloudflare/user-store/internal/credential-schema.ts"],
      })
    ).toBe(false);
    expect(rollbackCompatible({ ...base, changedPaths: ["infra/cloudflare/alchemy.run.ts"] })).toBe(
      false
    );

    for (const path of [
      ...base.workflowPaths,
      "infra/cloudflare/alchemy.storage.ts",
      "infra/cloudflare/storage-installation.ts",
      "apps/server/cloudflare/subscription/internal/billing-collection-workflow.ts",
      "apps/server/cloudflare/email-authentication/internal/onboarding-workflow.ts",
    ]) {
      expect(rollbackCompatible({ ...base, changedPaths: [path] })).toBe(false);
    }
  });
  it("refuses Durable Object lifecycle and binding changes", () => {
    expect(
      rollbackCompatible({
        ...base,
        candidate: worker("v2", base.candidate.bindings),
        changedPaths: [],
      })
    ).toBe(false);
    expect(
      rollbackCompatible({
        ...base,
        candidate: {
          ...base.candidate,
          exports: { Counter: { type: "durable-object", state: "renamed" } },
        },
        changedPaths: [],
      })
    ).toBe(false);
    expect(
      rollbackCompatible({
        ...base,
        candidate: worker("v1", { ...base.candidate.bindings, SECRET: { type: "secret_text" } }),
        changedPaths: [],
      })
    ).toBe(false);
  });
});

it("compares immutable namespace IDs from the Worker Versions response before a code rollback", () => {
  const stable = "a".repeat(40);
  const candidate = "b".repeat(40);

  const response = (revision: string, namespace: string, flip = false): unknown => {
    const bindings = [
      {
        name: "USER_STORE",
        type: "durable_object_namespace",
        class_name: "UserStore",
        namespace_id: namespace,
      },
      { name: "RELEASE_GIT_SHA", type: "plain_text", text: revision },
    ];

    return {
      success: true,
      result: {
        id: "10000000-0000-4000-8000-000000000001",
        resources: {
          script: {
            handlers: ["fetch"],
            named_handlers: [{ name: "UserStore", handlers: ["class"] }],
          },
          script_runtime: {
            compatibility_date: "2026-09-08",
            compatibility_flags: ["nodejs_compat"],
            usage_model: "standard",
          },
          bindings: flip ? bindings.reverse() : bindings,
        },
      },
    };
  };

  const version = "10000000-0000-4000-8000-000000000001";

  const established = verifiedVersionResources({
    raw: response(stable, "existing"),
    versionId: version,
    revision: stable,
  });

  const unchanged = verifiedVersionResources({
    raw: response(candidate, "existing", true),
    versionId: version,
    revision: candidate,
  });

  expect(
    rollbackCompatible({ ...base, stable: established, candidate: unchanged, changedPaths: [] })
  ).toBe(true);

  const replaced = verifiedVersionResources({
    raw: response(candidate, "replacement"),
    versionId: version,
    revision: candidate,
  });

  expect(
    rollbackCompatible({ ...base, stable: established, candidate: replaced, changedPaths: [] })
  ).toBe(false);
  expect(() =>
    verifiedVersionResources({
      raw: response(stable, "existing"),
      versionId: version,
      revision: candidate,
    })
  ).toThrow();
  expect(() =>
    verifiedVersionResources({ raw: response(stable, ""), versionId: version, revision: stable })
  ).toThrow();
});
