// oxlint-disable typescript/consistent-type-assertions -- Deliberately incomplete platform fixture throws on every access.
import { describe, expect, it } from "vitest";
import {
  type SmokeEnvironment,
  handleSmoke,
  receiveSmoke,
} from "../../apps/server/cloudflare/runtime/smoke-work";

const revision = "0123456789abcdef0123456789abcdef01234567";
const digest = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const version = "dc8dcd28-271b-4367-9840-6c244f84cb40";
const proof = "a".repeat(64);
const body = JSON.stringify({
  protocolVersion: 1,
  probeId: "b".repeat(32),
  expectedPublicVersionId: version,
  expectedCoreVersionId: version,
  expectedGitRevision: revision,
  expectedContractDigest: digest,
});

describe("private release smoke", () => {
  it("rejects missing authority, oversized input, and wrong Core version without touching any binding", async () => {
    let effects = 0;
    const binding = (): never => {
      effects++;
      throw new Error("must not run");
    };
    const environment = {
      DB: { prepare: binding },
      SMOKE_BUCKET: { put: binding },
      SMOKE_QUEUE: { send: binding },
      SMOKE_WORKFLOW: { create: binding },
      USER_TRANSACTION_COORDINATOR: { getByName: binding },
      CF_VERSION_METADATA: { id: "db7cd8d3-4425-4fe7-8c81-01bf963b6067" },
      SMOKE_QUEUE_NAME: "smoke",
      SMOKE_PROOF: proof,
      RELEASE_GIT_SHA: revision,
      CONTRACT_DIGEST: digest,
      KAPSO_API_KEY: "configured",
      KAPSO_WEBHOOK_SECRET: "configured",
      RESEND_API_KEY: "configured",
      WOMPI_PRIVATE_KEY: "configured",
      WOMPI_INTEGRITY_SECRET: "configured",
      WOMPI_EVENT_SECRET: "configured",
    } as unknown as SmokeEnvironment;
    const request = (payload: string, authorized: boolean): Request =>
      new Request("https://core.internal/internal/release-smoke", {
        method: "POST",
        body: payload,
        headers: {
          "content-type": "application/json",
          ...(authorized ? { "x-fidy-smoke-proof": proof } : {}),
        },
      });
    expect((await handleSmoke(request(body, false), environment)).status).toBe(404);
    expect((await handleSmoke(request("a".repeat(513), true), environment)).status).toBe(404);
    expect((await handleSmoke(request(body, true), environment)).status).toBe(503);
    expect(effects).toBe(0);
  });

  it("uses only reserved bindings and allows a stable consumer to hand off candidate synthetic work", async () => {
    const actions: Array<string> = [];
    let offered: unknown;
    let claimed = false;
    const database = {
      prepare: (
        sql: string
      ): {
        all: () => Promise<unknown>;
        bind: (...values: ReadonlyArray<unknown>) => {
          run: () => Promise<unknown>;
          first: () => Promise<unknown>;
        };
      } => ({
        all: (): Promise<unknown> => {
          actions.push("schema");
          return Promise.resolve({});
        },
        bind: (
          ...values: ReadonlyArray<unknown>
        ): { run: () => Promise<unknown>; first: () => Promise<unknown> } => ({
          run: (): Promise<unknown> => {
            actions.push(sql.startsWith("UPDATE") ? "synthetic-claim" : "synthetic-insert");
            if (sql.startsWith("UPDATE")) claimed = true;
            return Promise.resolve({ meta: { changes: 1 } });
          },
          first: (): Promise<unknown> => {
            actions.push("synthetic-read");
            return Promise.resolve(
              sql.includes("expires_at_ms FROM")
                ? { expires_at_ms: Date.now() + 100_000 }
                : {
                    git_revision: revision,
                    expires_at_ms: Date.now() + 100_000,
                    status: claimed ? "queued" : "pending",
                    id: values[0],
                  }
            );
          },
        }),
      }),
    };
    const environment = {
      DB: database,
      SMOKE_BUCKET: {
        put: (): Promise<void> => {
          actions.push("marker-write");
          return Promise.resolve();
        },
        get: (): Promise<object> => {
          actions.push("marker-read");
          return Promise.resolve({});
        },
      },
      SMOKE_QUEUE: {
        send: (value: unknown): Promise<void> => {
          offered = value;
          actions.push("queue");
          return Promise.resolve();
        },
      },
      SMOKE_WORKFLOW: {
        create: (): Promise<object> => {
          actions.push("workflow");
          return Promise.resolve({});
        },
      },
      USER_TRANSACTION_COORDINATOR: {
        getByName: (name: string): { fetch: () => Promise<Response> } => ({
          fetch: (): Promise<Response> => {
            actions.push(name);
            return Promise.resolve(Response.json({ status: "compatible" }));
          },
        }),
      },
      CF_VERSION_METADATA: { id: version },
      SMOKE_QUEUE_NAME: "reserved-smoke",
      SMOKE_PROOF: proof,
      RELEASE_GIT_SHA: revision,
      CONTRACT_DIGEST: digest,
      KAPSO_API_KEY: "configured",
      KAPSO_WEBHOOK_SECRET: "configured",
      RESEND_API_KEY: "configured",
      WOMPI_PRIVATE_KEY: "configured",
      WOMPI_INTEGRITY_SECRET: "configured",
      WOMPI_EVENT_SECRET: "configured",
    } as unknown as SmokeEnvironment;
    const result = await handleSmoke(
      new Request("https://core.internal/internal/release-smoke", {
        method: "POST",
        headers: { "content-type": "application/json", "x-fidy-smoke-proof": proof },
        body,
      }),
      environment
    );
    expect(result.status).toBe(202);
    expect(actions).toEqual([
      "synthetic-insert",
      "synthetic-read",
      "synthetic-claim",
      "schema",
      "schema",
      "marker-write",
      "marker-read",
      "_release-smoke-v1",
      "queue",
    ]);
    expect(offered).toEqual({ protocolVersion: 1, probeId: "b".repeat(32), gitRevision: revision });
    const replay = await handleSmoke(
      new Request("https://core.internal/internal/release-smoke", {
        method: "POST",
        headers: { "content-type": "application/json", "x-fidy-smoke-proof": proof },
        body,
      }),
      environment
    );
    expect(replay.status).toBe(202);
    expect(actions.filter((action) => action === "queue")).toHaveLength(1);
    expect(actions.filter((action) => action === "marker-write")).toHaveLength(1);
    const candidateWork = offered;
    const stableConsumer = { ...environment, RELEASE_GIT_SHA: "0".repeat(40) };
    await receiveSmoke(
      {
        queue: "reserved-smoke",
        messages: [
          {
            body: candidateWork,
            ack: (): void => {
              actions.push("ack");
            },
          },
        ],
      } as unknown as MessageBatch<unknown>,
      stableConsumer
    );
    expect(actions.slice(-3)).toEqual(["synthetic-read", "workflow", "ack"]);
  });
});
