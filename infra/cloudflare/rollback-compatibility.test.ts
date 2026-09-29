import { describe, expect, it } from "vitest";
import { rollbackCompatible } from "./rollback-compatibility";

const worker = (
  migrationTag: string,
  bindings: Readonly<Record<string, unknown>>
): {
  migrationTag: string;
  bindings: Readonly<Record<string, unknown>>;
  exports: Readonly<Record<string, unknown>>;
} => ({
  migrationTag,
  bindings,
  exports: { Counter: { type: "durable-object", state: "created" } },
});
const base = {
  stable: worker("v1", { DB: { type: "d1" } }),
  candidate: worker("v1", { DB: { type: "d1" } }),
  workflowPaths: ["apps/server/cloudflare/billing/billing-collection.ts"],
};
describe("rollback compatibility evidence", () => {
  it("accepts a code-only release with identical runtime resources", () => {
    expect(
      rollbackCompatible({ ...base, changedPaths: ["apps/server/cloudflare/core-worker.ts"] })
    ).toBe(true);
  });
  it("refuses schema and resource changes even when the old Worker version remains available", () => {
    expect(
      rollbackCompatible({ ...base, changedPaths: ["apps/server/cloudflare/migrations/0002.sql"] })
    ).toBe(false);
    expect(rollbackCompatible({ ...base, changedPaths: ["infra/cloudflare/alchemy.run.ts"] })).toBe(
      false
    );
    expect(rollbackCompatible({ ...base, changedPaths: base.workflowPaths })).toBe(false);
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
        candidate: worker("v1", { DB: { type: "d1" }, SECRET: { type: "secret_text" } }),
        changedPaths: [],
      })
    ).toBe(false);
  });
});
