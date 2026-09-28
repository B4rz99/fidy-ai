import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  maxActiveProbes,
  smokeAdmissionSql,
  smokeClaimSql,
} from "../../apps/server/cloudflare/runtime/smoke-work";

const migration = new URL(
  "../../apps/server/cloudflare/migrations/0027_release_smoke.sql",
  import.meta.url
);
const revision = "0123456789abcdef0123456789abcdef01234567";
const now = 1_000_000;
const expires = now + 300_000;
const probeId = (index: number): string => index.toString(16).padStart(32, "0");

/** SQLite runs the same D1 admission statements against the real migration across connections. */
describe("release smoke admission persistence", () => {
  it("caps distinct probes and atomically claims once across connections and reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "fidy-smoke-admission-"));
    const path = join(directory, "smoke.sqlite");
    const first = new Database(path, { create: true });
    const second = new Database(path);
    try {
      first.exec(await Bun.file(migration).text());
      first.exec("PRAGMA busy_timeout = 3000");
      second.exec("PRAGMA busy_timeout = 3000");
      const admit = (db: Database, index: number): void => {
        db.query(smokeAdmissionSql).run(probeId(index), revision, expires, now, maxActiveProbes);
      };
      for (let index = 0; index < maxActiveProbes + 2; index++) {
        admit(index % 2 === 0 ? first : second, index);
      }
      const count = (): unknown =>
        first.query("SELECT COUNT(*) AS total FROM release_smoke_probes").get();
      expect(count()).toEqual({ total: maxActiveProbes });
      first.query(smokeClaimSql).run(probeId(0), now);
      expect(first.query("SELECT changes() AS changed").get()).toEqual({ changed: 1 });
      second.query(smokeClaimSql).run(probeId(0), now);
      expect(second.query("SELECT changes() AS changed").get()).toEqual({ changed: 0 });
      admit(second, 0);
      expect(count()).toEqual({ total: maxActiveProbes });
      first.close();
      const reopened = new Database(path);
      try {
        expect(reopened.query("SELECT COUNT(*) AS total FROM release_smoke_probes").get()).toEqual({
          total: maxActiveProbes,
        });
        expect(
          reopened
            .query("SELECT status FROM release_smoke_probes WHERE probe_id = ?")
            .get(probeId(0))
        ).toEqual({
          status: "queued",
        });
      } finally {
        reopened.close();
      }
    } finally {
      first.close();
      second.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
