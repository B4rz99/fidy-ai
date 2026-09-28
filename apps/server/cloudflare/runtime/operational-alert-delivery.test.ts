import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { runOperationalAlerts } from "./operational-alert-delivery";
import type { OperationalAlert } from "./operational-alerts";

const instances: Miniflare[] = [];
const database = async (): Promise<D1Database> => {
  const instance = new Miniflare({
    workers: [
      {
        config: {
          name: "operational-alerts",
          type: "worker",
          compatibilityDate: "2026-09-08",
          env: { DB: { id: "operational-alerts", type: "d1" } },
          manifest: {
            mainModule: "index.mjs",
            modules: {
              "index.mjs": {
                contents: "export default {fetch() {return new Response('ok')}}",
                type: "esm",
              },
            },
          },
        },
      },
    ],
  });
  await instance.ready;
  instances.push(instance);
  const db = await instance.getD1Database("DB");
  await db
    .prepare(`CREATE TABLE operational_alerts (
    kind TEXT NOT NULL, owner TEXT NOT NULL, severity TEXT NOT NULL,
    state TEXT NOT NULL, first_seen_ms INTEGER NOT NULL, last_seen_ms INTEGER NOT NULL,
    last_attempt_ms INTEGER, attempt_started_ms INTEGER, delivery_confirmed INTEGER NOT NULL DEFAULT 0,
    next_attempt_ms INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    acknowledged_ms INTEGER, PRIMARY KEY (kind, owner)
  )`)
    .run();
  return db;
};
afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
});
const deadLetter: OperationalAlert = {
  kind: "dead_letters",
  owner: "deadLetters",
  severity: "critical",
};

describe("operator email notification", () => {
  it("delivers a new critical alert once and repeats after thirty minutes without changing work state", async () => {
    const db = await database();
    const sent: string[] = [];
    const send = async (_alert: OperationalAlert, key: string): Promise<void> => {
      sent.push(key);
    };
    await runOperationalAlerts({ db, now: 1_000_000, alerts: [deadLetter], send });
    await runOperationalAlerts({ db, now: 1_060_000, alerts: [deadLetter], send });
    await runOperationalAlerts({ db, now: 2_800_000, alerts: [deadLetter], send });
    expect(sent).toHaveLength(2);
    expect(sent[0]).not.toBe(sent[1]);
  });

  it("does not acknowledge or silently discard an alert when delivery fails", async () => {
    const db = await database();
    await expect(
      runOperationalAlerts({
        db,
        now: 1_000_000,
        alerts: [deadLetter],
        send: async () => {
          throw new Error("private delivery error");
        },
      })
    ).rejects.toThrow();
    const rows = await db
      .prepare("SELECT state, acknowledged_ms, attempts FROM operational_alerts")
      .all();
    expect(rows.results).toEqual([{ state: "firing", acknowledged_ms: null, attempts: 1 }]);
  });

  it("reuses one idempotency key after an ambiguous attempt before starting another notification", async () => {
    const db = await database();
    const keys: string[] = [];
    await expect(
      runOperationalAlerts({
        db,
        now: 1_000_000,
        alerts: [deadLetter],
        send: async (_alert, key) => {
          keys.push(key);
          throw new Error("lost provider response");
        },
      })
    ).rejects.toThrow();
    await runOperationalAlerts({
      db,
      now: 2_800_000,
      alerts: [deadLetter],
      send: async (_alert, key) => {
        keys.push(key);
      },
    });
    expect(keys).toEqual([keys[0], keys[0]]);
  });

  it("does not replay an unconfirmed provider send after its idempotency window expires", async () => {
    const db = await database();
    const sent: string[] = [];
    await expect(
      runOperationalAlerts({
        db,
        now: 1_000_000,
        alerts: [deadLetter],
        send: async (_alert, key) => {
          sent.push(key);
          throw new Error("lost provider response");
        },
      })
    ).rejects.toThrow();
    await expect(
      runOperationalAlerts({
        db,
        now: 84_000_000,
        alerts: [deadLetter],
        send: async (_alert, key) => {
          sent.push(key);
        },
      })
    ).rejects.toThrow("Operator alert email unavailable");
    expect(sent).toHaveLength(1);
  });

  it("resolves absent conditions, then notifies when the condition returns", async () => {
    const db = await database();
    const sent: string[] = [];
    const send = async (_alert: OperationalAlert, key: string): Promise<void> => {
      sent.push(key);
    };
    await runOperationalAlerts({ db, now: 1_000_000, alerts: [deadLetter], send });
    await runOperationalAlerts({ db, now: 1_100_000, alerts: [], send });
    await runOperationalAlerts({ db, now: 1_200_000, alerts: [deadLetter], send });
    expect(sent).toHaveLength(2);
  });
});
