import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const script = join(process.cwd(), "scripts/check-legacy-authorities.ts");
const roots: Array<string> = [];

const fixture = (files: Readonly<Record<string, string>>): string => {
  const root = mkdtempSync(join(tmpdir(), "fidy-legacy-authorities-"));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const destination = join(root, path);
    mkdirSync(join(destination, ".."), { recursive: true });
    writeFileSync(destination, contents);
  }
  return root;
};

const check = (root: string): { readonly code: number; readonly stderr: string } => {
  const result = spawnSync("bun", [script, "--root", root], { encoding: "utf8" });
  return { code: result.status ?? 1, stderr: result.stderr };
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("allows Cloudflare production code and Bun-only development tools", () => {
  const root = fixture({
    "apps/server/package.json": JSON.stringify({
      dependencies: { "@effect/sql-d1": "4.0.0" },
      devDependencies: { "@effect/platform-bun": "4.0.0" },
    }),
    "apps/server/cloudflare/core.ts": "import { D1Client } from '@effect/sql-d1';",
    "infra/cloudflare/scripts/new-dev-tool.ts":
      "import { BunServices } from '@effect/platform-bun';",
    "research/legacy.ts": "import { PgClient } from '@effect/sql-pg';",
  });
  expect(check(root).code).toBe(0);
});

it("rejects a production PostgreSQL dependency without banning Bun development tools", () => {
  const root = fixture({
    "apps/server/package.json": JSON.stringify({ dependencies: { "@effect/sql-pg": "4.0.0" } }),
  });
  const result = check(root);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("apps/server/package.json: @effect/sql-pg");
});

it("rejects a PostgreSQL peer dependency in a production manifest", () => {
  const root = fixture({
    "apps/server/package.json": JSON.stringify({ peerDependencies: { "@effect/sql-pg": "*" } }),
  });
  const result = check(root);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("apps/server/package.json: @effect/sql-pg");
});

it("rejects the pg driver as a production dependency", () => {
  const root = fixture({
    "apps/server/package.json": JSON.stringify({ dependencies: { pg: "8.0.0" } }),
  });
  const result = check(root);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("apps/server/package.json: pg");
});

it("rejects legacy imports in the Worker graph", () => {
  const root = fixture({
    "apps/server/cloudflare/core.ts": "import { BunServices } from '@effect/platform-bun';",
  });
  const result = check(root);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("apps/server/cloudflare/core.ts: @effect/platform-bun");
});

it("rejects Effect Cluster in the Worker graph", () => {
  const root = fixture({
    "apps/server/cloudflare/core.ts": "import * as Cluster from 'effect/unstable/cluster';",
  });
  const result = check(root);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("apps/server/cloudflare/core.ts: effect/unstable/cluster");
});

it("rejects the pg driver in the Worker graph", () => {
  const root = fixture({ "apps/server/cloudflare/core.ts": "import { Pool } from 'pg';" });
  const result = check(root);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("apps/server/cloudflare/core.ts: pg");
});

it("follows package-script indirection from a production command", () => {
  const root = fixture({
    "infra/cloudflare/package.json": JSON.stringify({
      scripts: { "production:ship": "bun run prepare", prepare: "bun scripts/prepare.ts" },
    }),
    "infra/cloudflare/scripts/prepare.ts": "import { BunServices } from '@effect/platform-bun';",
  });
  const result = check(root);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("infra/cloudflare/scripts/prepare.ts: @effect/platform-bun");
});

it("allows Bun platform services in deployment tooling", () => {
  const root = fixture({
    "infra/cloudflare/package.json": JSON.stringify({
      scripts: { deploy: "bun scripts/deploy.ts" },
    }),
    "infra/cloudflare/scripts/deploy.ts": "import { BunServices } from '@effect/platform-bun';",
  });
  const result = check(root);
  expect(result.code).toBe(0);
});

it("rejects a Bun production listener without legacy imports", () => {
  const root = fixture({
    "apps/server/package.json": JSON.stringify({ scripts: { start: "bun scripts/start.ts" } }),
    "apps/server/scripts/start.ts": "Bun.serve({ fetch: () => new Response('ok') });",
  });
  const result = check(root);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("apps/server/package.json: start production process entrypoint");
});

it("rejects a Bun-only production entrypoint", () => {
  const root = fixture({
    "apps/server/package.json": JSON.stringify({ scripts: { start: "bun scripts/start.ts" } }),
    "apps/server/scripts/start.ts": "import { BunServices } from '@effect/platform-bun';",
  });
  const result = check(root);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("apps/server/scripts/start.ts: @effect/platform-bun");
});

it("rejects a production command implemented by a legacy script", () => {
  const root = fixture({
    "apps/server/package.json": JSON.stringify({ scripts: { start: "bun scripts/start.ts" } }),
    "apps/server/scripts/start.ts": "import { PgClient } from '@effect/sql-pg';",
  });
  const result = check(root);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("apps/server/scripts/start.ts: @effect/sql-pg");
});

it("rejects a test that requires PostgreSQL execution", () => {
  const root = fixture({
    "apps/server/cloudflare/storage.test.ts": "import { PgClient } from '@effect/sql-pg';",
  });
  const result = check(root);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("apps/server/cloudflare/storage.test.ts: @effect/sql-pg");
});

it("rejects PostgreSQL imports from server tooling tests", () => {
  const root = fixture({
    "apps/server/tools/release.test.ts": "import { Pool } from '@effect/sql-pg';",
  });
  const result = check(root);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("apps/server/tools/release.test.ts: @effect/sql-pg");
});

it("rejects a Bun-only Worker test without banning Bun tooling", () => {
  const root = fixture({
    "apps/server/cloudflare/core.test.ts": "import { BunServices } from '@effect/platform-bun';",
  });
  const result = check(root);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("apps/server/cloudflare/core.test.ts: @effect/platform-bun");
});

it("allows a test that asserts the old authority is rejected", () => {
  const root = fixture({
    "apps/server/cloudflare/rejection.test.ts": "expect(config).not.toContain('postgres');",
  });
  expect(check(root).code).toBe(0);
});

it("rejects PostgreSQL URLs and psql subprocesses in tests", () => {
  const root = fixture({
    "apps/server/cloudflare/db.test.ts":
      "const url = 'postgres://localhost/test';\nexecFileSync('psql', ['-c', 'select 1']);",
  });
  const result = check(root);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("apps/server/cloudflare/db.test.ts: postgres");
  expect(result.stderr).toContain("apps/server/cloudflare/db.test.ts: psql");
});

it("rejects a PostgreSQL test fixture without a direct SQL import", () => {
  const root = fixture({
    "apps/server/cloudflare/fixtures/database.fixture.ts": "export const service = 'postgres:17';",
  });
  const result = check(root);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("apps/server/cloudflare/fixtures/database.fixture.ts: postgres");
});

it("rejects legacy SQL queue tables", () => {
  const root = fixture({
    "apps/server/cloudflare/migrations/0002_queue.sql": "CREATE TABLE persisted_queue (id TEXT);",
  });
  const result = check(root);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(
    "apps/server/cloudflare/migrations/0002_queue.sql: persisted_queue"
  );
});

it("rejects PostgreSQL-specific migration SQL", () => {
  const root = fixture({
    "apps/server/cloudflare/migrations/0002_new.sql": "CREATE ROLE migrator;",
  });
  const result = check(root);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("apps/server/cloudflare/migrations/0002_new.sql: CREATE ROLE");
});

it("rejects PostgreSQL deployment configuration in a new top-level directory", () => {
  const root = fixture({ "ops/deploy.yml": "database: postgres\n" });
  const result = check(root);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("ops/deploy.yml: postgres");
});

it("rejects a Cloudflare configuration with a Hyperdrive binding", () => {
  const root = fixture({
    "infra/cloudflare/wrangler.jsonc": '{ "hyperdrive": [{ "binding": "DB" }] }',
  });
  const result = check(root);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("infra/cloudflare/wrangler.jsonc: hyperdrive");
});

it("rejects Railway configuration even when no source imports it", () => {
  const root = fixture({ "railway.json": "{}" });
  const result = check(root);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("railway.json: legacy production path");
});

it("rejects obsolete Docker production configuration", () => {
  const root = fixture({ ".dockerignore": "node_modules\n" });
  const result = check(root);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(".dockerignore: legacy production path");
});

it("rejects PostgreSQL services in CI while leaving history out of scope", () => {
  const root = fixture({
    ".github/workflows/ci.yml": "services:\n  postgres:\n    image: postgres:17\n",
    "docs/adr/old.md": "Railway and PostgreSQL",
  });
  const result = check(root);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(".github/workflows/ci.yml: postgres");
});
