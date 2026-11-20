// Only the Git-pinned application modules and migrations run in the disposable D1 comparator.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";

export const baseline = "fb53d9e755c14393048dc945fc0b7f117730d872";
export const origin = "https://127.0.0.1:4173";
const text = (value) => ({ type: "text", value });
const coordinator = {
  type: "durable-object",
  worker: "core",
  exportName: "UserTransactionCoordinator",
};

export async function d1Platform(root) {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  assert.equal(git("rev-parse", "HEAD"), baseline);
  assert.equal(git("diff", "HEAD", "--name-only"), "");
  const shared = {
    BROWSER_ORIGIN: text(origin),
    RELEASE_GIT_SHA: text(baseline),
    CONTRACT_DIGEST: text("a".repeat(64)),
  };
  async function worker(name, entry, env, exports = {}) {
    const build = await Bun.build({
      entrypoints: [resolve(root, "apps/server/cloudflare/" + entry + ".ts")],
      target: "browser",
      external: ["cloudflare:workers", "node:*"],
    });
    assert.ok(build.success, "Frozen Worker failed to bundle");
    return {
      config: {
        type: "worker",
        name,
        compatibilityDate: "2026-09-08",
        compatibilityFlags: [
          "nodejs_compat",
          "enable_request_signal",
          "request_signal_passthrough",
        ],
        env: { ...shared, ...env },
        exports,
        manifest: {
          mainModule: "index.mjs",
          modules: {
            "index.mjs": { type: "esm", contents: await build.outputs[0].text() },
          },
        },
      },
    };
  }
  const runtime = new Miniflare({
    workers: [
      await worker("ingress", "public-worker", {
        CORE: { type: "worker", worker: "core" },
        PAT_ADMISSION_KEY: text("test-only-admission-key-with-32-bytes"),
        LOCAL_CANONICAL_READ_BEARER: text(""),
        ERASURE_REGISTRY_COORDINATOR: coordinator,
      }),
      await worker(
        "core",
        "core-worker",
        {
          DB: { type: "d1", id: "shared-frozen-store" },
          ERASURE_REQUIRED: text("true"),
          ERASURE_BUCKET: { type: "r2", name: "erasure" },
          USER_TRANSACTION_COORDINATOR: coordinator,
          ERASURE_REGISTRY_COORDINATOR: coordinator,
          WHATSAPP_BUSINESS_PORTFOLIO_ID: text("portfolio"),
          OPENAI_API_KEY: text(""),
          HOSTED_AI_MODEL: text("unused"),
        },
        { UserTransactionCoordinator: { type: "durable-object", storage: "sqlite" } }
      ),
    ],
  });
  try {
    const db = await runtime.getD1Database("DB", "core");
    const dir = resolve(root, "apps/server/cloudflare/migrations");
    for (const name of (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort()) {
      const sql = (await Bun.file(resolve(dir, name)).text())
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter(Boolean);
      for (let i = 0; i < sql.length; i += 15)
        await db.batch(sql.slice(i, i + 15).map((s) => db.prepare(s)));
    }
    await (
      await runtime.getR2Bucket("ERASURE_BUCKET", "core")
    ).put("recovery/generation", "initial");
    const disclosure = execFileSync(
      process.execPath,
      [
        "-e",
        'import {currentDisclosureFor} from "./apps/server/src/shell/consent/operations"; process.stdout.write(JSON.stringify(currentDisclosureFor()))',
      ],
      { cwd: root, encoding: "utf8" }
    );
    const owner = {
      exec: async (sql, ...params) =>
        (
          await db
            .prepare(sql)
            .bind(...params)
            .all()
        ).results,
    };
    return {
      runtime,
      owner,
      async prepare(subject, caller) {
        const now = Date.now();
        await owner.exec(
          "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms,whatsapp_portfolio_id,whatsapp_bsuid,whatsapp_verified_at_ms) VALUES (?,'CO','es-CO','America/Bogota',?,'portfolio',?,?)",
          subject,
          now,
          caller,
          now - 1000
        );
        await owner.exec(
          "INSERT INTO consent_history(record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms) VALUES ('processing_grant',?,?,?,?,?,?,?)",
          crypto.randomUUID(),
          subject,
          disclosure,
          crypto.randomUUID(),
          crypto.randomUUID(),
          now,
          now
        );
      },
      async approve(subject, pair) {
        await owner.exec(
          "UPDATE browser_login_pairings SET approval_portfolio_id='portfolio', approval_message_id=?, approval_user_id=? WHERE id=? AND state='pending_approval' AND approval_message_id IS NULL",
          crypto.randomUUID(),
          subject,
          pair.pairingId
        );
      },
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
