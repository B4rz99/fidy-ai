// Only the Git-pinned application modules and migrations run in the disposable D1 comparator.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import { inOrder, indices } from "./sequence.mjs";

export const baseline = "fb53d9e755c14393048dc945fc0b7f117730d872";
export const origin = "https://127.0.0.1:4173";
const text = (value) => ({ type: "text", value });
const coordinator = {
  type: "durable-object",
  worker: "core",
  exportName: "UserTransactionCoordinator",
};

const sha256Width = 64,
  migrationBatchSize = 15,
  secondMs = 1000;
const shared = {
  BROWSER_ORIGIN: text(origin),
  RELEASE_GIT_SHA: text(baseline),
  CONTRACT_DIGEST: text("a".repeat(sha256Width)),
};
const worker = async (root, { name, entry, env, exports = {} }) => {
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
      compatibilityFlags: ["nodejs_compat", "enable_request_signal", "request_signal_passthrough"],
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
};
const runtimeFor = async (root, logs) =>
  new Miniflare({
    handleStructuredLogs: (log) => {
      logs.push(log.message);
    },
    workers: [
      await worker(root, {
        name: "ingress",
        entry: "public-worker",
        env: {
          CORE: { type: "worker", worker: "core" },
          PAT_ADMISSION_KEY: text("test-only-admission-key-with-32-bytes"),
          LOCAL_CANONICAL_READ_BEARER: text(""),
          ERASURE_REGISTRY_COORDINATOR: coordinator,
        },
      }),
      await worker(root, {
        name: "core",
        entry: "core-worker",
        env: {
          DB: { type: "d1", id: "shared-frozen-store" },
          ERASURE_REQUIRED: text("true"),
          ERASURE_BUCKET: { type: "r2", name: "erasure" },
          USER_TRANSACTION_COORDINATOR: coordinator,
          ERASURE_REGISTRY_COORDINATOR: coordinator,
          WHATSAPP_BUSINESS_PORTFOLIO_ID: text("portfolio"),
          OPENAI_API_KEY: text(""),
          HOSTED_AI_MODEL: text("unused"),
        },
        exports: { UserTransactionCoordinator: { type: "durable-object", storage: "sqlite" } },
      }),
    ],
  });

const migrate = async (db, root) => {
  const dir = resolve(root, "apps/server/cloudflare/migrations");
  const names = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  await inOrder(names, async (name) => {
    const sql = (await Bun.file(resolve(dir, name)).text())
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);
    await inOrder(indices(Math.ceil(sql.length / migrationBatchSize)), (batch) => {
      const start = batch * migrationBatchSize;
      return db.batch(
        sql.slice(start, start + migrationBatchSize).map((statement) => db.prepare(statement))
      );
    });
  });
};
const prepareStorage = async (runtime, root) => {
  const db = await runtime.getD1Database("DB", "core");
  await migrate(db, root);
  await (await runtime.getR2Bucket("ERASURE_BUCKET", "core")).put("recovery/generation", "initial");
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
        now - secondMs
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
};
export const d1Platform = async (root) => {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  assert.equal(git("rev-parse", "HEAD"), baseline);
  assert.equal(git("diff", "HEAD", "--name-only"), "");
  // Match the native browser fixture’s host-side structured log sink.
  const runtime = await runtimeFor(root, []);
  try {
    return await prepareStorage(runtime, root);
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
};
